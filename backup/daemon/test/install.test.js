"use strict";

/**
 * install.test.js — pure-path logic of the self-installer. The side-effectful
 * functions (install/uninstall/selfDelete) are exercised manually against a
 * packaged binary; here we pin down WHERE things install so a regression can't
 * silently move the daemon out of ~/.devaccel.
 * Run with: node --test
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const cfg = require("../config");
const { installPaths, legacyInstallPaths, setupFileName } = require("../install");

test("binary installs inside the ~/.devaccel state dir", () => {
  const { dir, target } = installPaths();
  assert.strictEqual(path.resolve(dir), path.resolve(cfg.STATE_DIR));
  assert.strictEqual(path.dirname(target), dir);
  assert.strictEqual(
    path.basename(target),
    process.platform === "win32" ? "devaccel.exe" : "devaccel",
  );
});

test("legacy paths point at the pre-0.3.0 locations", () => {
  const legacy = legacyInstallPaths();
  assert.strictEqual(path.dirname(legacy.target), legacy.dir);
  if (process.platform === "win32") {
    assert.match(legacy.dir, /[\\/]DevAccel$/);
    assert.strictEqual(path.basename(legacy.target), "devaccel.exe");
    assert.strictEqual(legacy.removeDir, true); // dir is ours alone — safe to delete
  } else {
    assert.match(legacy.dir, /[\\/]\.local[\\/]bin$/);
    assert.strictEqual(path.basename(legacy.target), "devaccel");
    assert.strictEqual(legacy.removeDir, false); // shared dir — file-only cleanup
  }
  // Never the same place as the new install (that would self-delete on migrate).
  assert.notStrictEqual(path.resolve(legacy.target), path.resolve(installPaths().target));
});

test("setup file name differs from the live binary name", () => {
  // The one-liner/self-update download must never collide with the running exe.
  assert.notStrictEqual(setupFileName(), path.basename(installPaths().target));
  assert.match(setupFileName(), /^devaccel-setup(\.exe)?$/);
});
