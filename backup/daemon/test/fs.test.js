"use strict";

/**
 * fs.test.js — unit tests for the sandboxed filesystem layer (no HTTP).
 * Run with: node --test
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");

const fsx = require("../fs");

async function tmpRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "devaccel-fs-"));
  return dir;
}

test("resolveInRoot allows paths inside the root", () => {
  const root = path.resolve("/work/ws");
  assert.strictEqual(fsx.resolveInRoot(root, "src/app.ts"), path.resolve("/work/ws/src/app.ts"));
  assert.strictEqual(fsx.resolveInRoot(root, "/src/app.ts"), path.resolve("/work/ws/src/app.ts"));
  assert.strictEqual(fsx.resolveInRoot(root, ""), path.resolve("/work/ws"));
});

test("resolveInRoot blocks path traversal", () => {
  const root = path.resolve("/work/ws");
  assert.throws(() => fsx.resolveInRoot(root, "../../etc/passwd"), /escapes workspace root/);
  assert.throws(() => fsx.resolveInRoot(root, "../sibling"), /escapes workspace root/);
  assert.throws(() => fsx.resolveInRoot(root, "a/../../b"), /escapes workspace root/);
});

test("write then read round-trips and creates parent dirs", async () => {
  const root = await tmpRoot();
  await fsx.writeFile(root, "nested/deep/file.txt", "hello");
  const content = await fsx.readFile(root, "nested/deep/file.txt");
  assert.strictEqual(content, "hello");
});

test("createEntry makes files and folders; does not clobber existing files", async () => {
  const root = await tmpRoot();
  await fsx.createEntry(root, "folder", "folder");
  await fsx.writeFile(root, "keep.txt", "original");
  await fsx.createEntry(root, "keep.txt", "file"); // must not overwrite
  assert.strictEqual(await fsx.readFile(root, "keep.txt"), "original");
});

test("removeEntry deletes files and folders recursively", async () => {
  const root = await tmpRoot();
  await fsx.writeFile(root, "dir/a.txt", "a");
  await fsx.writeFile(root, "dir/b.txt", "b");
  await fsx.removeEntry(root, "dir");
  await assert.rejects(() => fsx.readFile(root, "dir/a.txt"));
});

test("rename moves a file", async () => {
  const root = await tmpRoot();
  await fsx.writeFile(root, "old.txt", "x");
  await fsx.rename(root, "old.txt", "renamed/new.txt");
  assert.strictEqual(await fsx.readFile(root, "renamed/new.txt"), "x");
  await assert.rejects(() => fsx.readFile(root, "old.txt"));
});

test("scan lists files/folders, skips noise dirs and hidden subfiles", async () => {
  const root = await tmpRoot();
  await fsx.writeFile(root, "src/index.ts", "1");
  await fsx.writeFile(root, "README.md", "2");
  await fsx.writeFile(root, "node_modules/pkg/index.js", "3"); // must be skipped
  await fsx.writeFile(root, "src/.secret", "4");               // hidden subfile skipped
  const nodes = await fsx.scan(root);
  const paths = nodes.map((n) => n.path);
  assert.ok(paths.includes("src"));
  assert.ok(paths.includes("src/index.ts"));
  assert.ok(paths.includes("README.md"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules")), "node_modules must be skipped");
  assert.ok(!paths.includes("src/.secret"), "hidden subfiles must be skipped");
  // folders sort before files
  assert.strictEqual(nodes[0].type, "folder");
});

/* ── Raw bytes ─────────────────────────────────────────────────────────────
   readFile/writeFile go through UTF-8, which silently destroys any non-text
   format: a .docx round-tripped that way is replacement characters that no
   parser can recover. These two carry the real bytes, which is what document
   extraction in the browser needs. */

test("readFileBytes round-trips bytes that UTF-8 would corrupt", async () => {
  const root = await tmpRoot();
  // 0x89 'PNG' — the high byte is not valid UTF-8 on its own.
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  await fsp.writeFile(path.join(root, "logo.png"), original);

  const { base64, size } = await fsx.readFileBytes(root, "logo.png");
  assert.strictEqual(size, original.length);
  assert.ok(Buffer.from(base64, "base64").equals(original), "bytes must survive the round trip");

  // The text path mangles the same file — this is the bug being avoided.
  const asText = await fsx.readFile(root, "logo.png");
  assert.ok(!Buffer.from(asText, "utf8").equals(original));
});

test("readFileBytes refuses a file over maxBytes instead of loading it", async () => {
  const root = await tmpRoot();
  await fsp.writeFile(path.join(root, "big.bin"), Buffer.alloc(4096));
  await assert.rejects(
    () => fsx.readFileBytes(root, "big.bin", 1024),
    (e) => e.code === "EFBIG",
  );
});

test("writeFileBytes writes raw bytes and creates parent dirs", async () => {
  const root = await tmpRoot();
  const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfe, 0xff, 0x00, 0x01]);
  const { size } = await fsx.writeFileBytes(root, ".devaccel/input/spec.docx", original.toString("base64"));

  assert.strictEqual(size, original.length);
  const onDisk = await fsp.readFile(path.join(root, ".devaccel/input/spec.docx"));
  assert.ok(onDisk.equals(original));
});

test("byte helpers stay inside the root", async () => {
  const root = await tmpRoot();
  await assert.rejects(() => fsx.readFileBytes(root, "../outside.bin"));
  await assert.rejects(() => fsx.writeFileBytes(root, "../outside.bin", "AAAA"));
});
