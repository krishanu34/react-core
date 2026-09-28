"use strict";

/**
 * search.test.js — daemon-side grep/glob (no HTTP).
 * Run with: node --test
 *
 * Scenarios mirror backend/tests/test_search_tools.py on purpose: the browser
 * falls back between these two engines depending on transport, and the model
 * must see one contract wherever the search ran. Every case here is a
 * distilled brownfield failure: a noisy generated file starving results,
 * nested vendor dirs leaking in, no distribution view, no context.
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");

const { grep, glob, matchesGlob } = require("../search");

async function brownfield() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "devaccel-search-"));
  async function w(rel, content, ageDays = 0) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
    if (ageDays) {
      const old = new Date(Date.now() - ageDays * 86400_000);
      await fsp.utimes(p, old, old);
    }
  }
  await w(
    "legacy/generated_bundle.js",
    Array.from({ length: 300 }, (_, i) => `function authenticate_${i}() {}`).join("\n"),
  );
  await w(
    "src/auth/service.py",
    "class AuthService:\n" +
    "    def authenticate(self, user, password):\n" +
    "        # the real one\n" +
    "        return check(user, password)\n",
  );
  await w("src/api/routes.py", "from auth.service import AuthService\n# calls authenticate()\n");
  await w("packages/app/node_modules/lib/index.js", "function authenticate() { /* vendor */ }\n");
  await w("src/auth/legacy.py", "def old_authenticate(\n        user,\n        password):\n    pass\n");
  await w("old/ancient.py", "# authenticate here too\n", 900);
  await w("src/recent.py", "# just touched\n");
  return root;
}

test("noisy file cannot starve real results (per-file cap)", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "authenticate" });
  const perFile = {};
  for (const m of r.matches) perFile[m.file] = (perFile[m.file] || 0) + 1;
  assert.ok((perFile["legacy/generated_bundle.js"] || 0) <= 5, "per-file cap broken");
  assert.ok(perFile["src/auth/service.py"], "real definition starved out");
});

test("nested vendor dirs excluded without .gitignore", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "authenticate" });
  assert.ok(!r.matches.some((m) => m.file.includes("node_modules")));
  const s = await grep(root, { query: "authenticate", output_mode: "files_with_matches" });
  assert.ok(!s.files.some((f) => f.includes("node_modules")));
});

test("files_with_matches shows the distribution", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "authenticate", output_mode: "files_with_matches" });
  assert.strictEqual(r.output_mode, "files_with_matches");
  assert.strictEqual(r.total_files, 5);
  assert.ok(r.files.includes("src/auth/service.py"));
});

test("count mode ranks hot spots first", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "authenticate", output_mode: "count" });
  assert.strictEqual(r.counts[0].file, "legacy/generated_bundle.js");
  assert.strictEqual(r.counts[0].matches, 300);
  assert.ok(r.total_matches >= 304);
});

test("context shows before AND after lines", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "def authenticate", context: 2 });
  const hit = r.matches.find((m) => m.file === "src/auth/service.py");
  assert.ok(hit.snippet.includes("class AuthService"), "before-context missing");
  assert.ok(hit.snippet.includes("# the real one"), "after-context missing");
  const matchRow = hit.snippet.split("\n").find((row) => row.includes("def authenticate"));
  assert.ok(matchRow.slice(0, matchRow.indexOf("def")).includes(":"));
});

test("multiline finds a wrapped signature", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "def old_authenticate\\(.*?password\\)", multiline: true });
  assert.ok(r.total_matches >= 1);
  assert.strictEqual(r.matches[0].file, "src/auth/legacy.py");
});

test("head_limit and offset page through", async () => {
  const root = await brownfield();
  const p1 = await grep(root, { query: "authenticate", head_limit: 3 });
  const p2 = await grep(root, { query: "authenticate", head_limit: 3, offset: 3 });
  assert.strictEqual(p1.matches.length, 3);
  assert.notDeepStrictEqual(p1.matches, p2.matches);
  assert.ok(p1.truncated);
  assert.ok(p1.message.includes("offset=3"));
});

test("file_pattern filters", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "authenticate", file_pattern: "*.py" });
  assert.ok(r.matches.length > 0);
  assert.ok(r.matches.every((m) => m.file.endsWith(".py")));
});

test("no matches is a message, not an error", async () => {
  const root = await brownfield();
  const r = await grep(root, { query: "zz_never_appears_zz" });
  assert.strictEqual(r.total_matches, 0);
  assert.ok(r.message.includes("No matches"));
  assert.ok(!("error" in r));
});

test("binary content is skipped by sniff, not just extension", async () => {
  const root = await brownfield();
  // A NUL-bearing file with a text extension — extension lists can't catch it.
  await fsp.writeFile(path.join(root, "dump.txt"), Buffer.from([0x61, 0x00, 0x62, 0x63]));
  const r = await grep(root, { query: "a" });
  assert.ok(!r.matches.some((m) => m.file === "dump.txt"));
});

test("glob sorts newest-modified first", async () => {
  const root = await brownfield();
  const r = await glob(root, "*.py");
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes("src/recent.py") && paths.includes("old/ancient.py"));
  assert.ok(paths.indexOf("src/recent.py") < paths.indexOf("old/ancient.py"));
  assert.strictEqual(r.sorted_by, "modification time, newest first");
  assert.ok(r.files.every((f) => typeof f.modified === "string"));
});

test("glob scoped to a subdirectory keeps the prefix in results", async () => {
  const root = await brownfield();
  const r = await glob(root, "*.py", "src");
  assert.ok(r.files.length > 0);
  assert.ok(r.files.every((f) => f.path.startsWith("src/")));
});

test("matchesGlob semantics match the server tool", () => {
  assert.ok(matchesGlob("src/deep/a.py", "*.py"));       // basename, any depth
  assert.ok(!matchesGlob("a.pyc", "*.py"));
  assert.ok(matchesGlob("src/lib/x/y.ts", "src/**/*.ts"));
  assert.ok(matchesGlob("src/y.ts", "src/**/*.ts"));      // ** matches zero dirs
  assert.ok(!matchesGlob("other/y.ts", "src/**/*.ts"));
  assert.ok(matchesGlob("top.json", "**/*.json"));
});
