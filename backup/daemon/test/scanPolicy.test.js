"use strict";

/**
 * Daemon-side scan policy.
 *
 * This exists because grep and glob are CLIENT tools: for anyone using the
 * daemon, the server's policy never executes. Testing only the Python side
 * would leave the behaviour unverified for exactly the users whose machine
 * holds the files. The assertions deliberately mirror
 * backend/tests/test_scan_policy.py — when the two sides disagree, that is
 * the bug.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scanPolicy = require("../scanPolicy");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devaccel-test-"));
}

test("dependencies are pruned by default", () => {
  const p = scanPolicy.build(tmpdir());
  for (const d of ["node_modules", ".venv", "build", "__pycache__"]) {
    assert.strictEqual(p.skipDir(d, d), true, d);
  }
});

test(".git is pruned in every mode", () => {
  const dir = tmpdir();
  for (const p of [
    scanPolicy.build(dir),
    scanPolicy.build(dir, { includeIgnored: true }),
    scanPolicy.build(dir, { path: ".git" }),
  ]) {
    assert.strictEqual(p.skipDir(".git", ".git"), true);
  }
});

test("targeting a dependency unlocks it and the path down to it", () => {
  // Pruning node_modules while targeting node_modules/express would make
  // targeting a no-op — the walk could never reach the target.
  const p = scanPolicy.build(tmpdir(), { path: "node_modules/express" });
  assert.strictEqual(p.skipDir("node_modules", "node_modules"), false);
  assert.strictEqual(p.skipDir("express", "node_modules/express"), false);
  assert.strictEqual(p.skipDir("lib", "node_modules/express/lib"), false);
  // …but not everything else.
  assert.strictEqual(p.skipDir(".venv", ".venv"), true);
});

test("a glob rooted in a dependency targets it", () => {
  const p = scanPolicy.build(tmpdir(), { filePattern: "node_modules/express/**/*.js" });
  assert.deepStrictEqual(p.targets, ["node_modules/express"]);
  assert.strictEqual(p.skipDir("express", "node_modules/express"), false);
});

test("a wildcard-only pattern targets nothing", () => {
  const p = scanPolicy.build(tmpdir(), { filePattern: "*.py" });
  assert.deepStrictEqual(p.targets, []);
  assert.strictEqual(p.skipDir("node_modules", "node_modules"), true);
});

test("includeIgnored opens everything but the hard skips", () => {
  const p = scanPolicy.build(tmpdir(), { includeIgnored: true });
  assert.strictEqual(p.skipDir("node_modules", "node_modules"), false);
  assert.strictEqual(p.skipDir(".venv", ".venv"), false);
  assert.strictEqual(p.skipDir(".devaccel", ".devaccel"), true);
});

test("the project's own .gitignore directories are honoured", () => {
  // `generated/` is nobody's convention — only this repo knows it is output.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".gitignore"), "generated/\n*.log\n# c\n!keep/\n");
  const p = scanPolicy.build(dir);
  assert.strictEqual(p.fromProject, true);
  assert.strictEqual(p.skipDir("generated", "generated"), true);
  // and they SUPPLEMENT the defaults rather than replacing them
  assert.strictEqual(p.skipDir("node_modules", "node_modules"), true);
});

test(".github is not treated as tool state", () => {
  const p = scanPolicy.build(tmpdir());
  assert.strictEqual(p.skipDir(".github", ".github"), false);
  assert.strictEqual(p.skipDir(".idea", ".idea"), true);
});

test("literalPrefix matches the Python implementation", () => {
  assert.strictEqual(scanPolicy.literalPrefix("node_modules/express/**/*.js"), "node_modules/express");
  assert.strictEqual(scanPolicy.literalPrefix("src/**/*.py"), "src");
  assert.strictEqual(scanPolicy.literalPrefix("*.py"), "");
  assert.strictEqual(scanPolicy.literalPrefix(""), "");
});
