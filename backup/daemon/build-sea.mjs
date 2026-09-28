/**
 * build-sea.mjs — build a single-file daemon executable using Node's built-in
 * Single Executable Applications (SEA) feature.
 *
 * WHY SEA (not pkg): SEA reuses the *local* Node binary, so it needs NO network
 * downloads — unlike `pkg`, which must fetch a prebuilt Node base binary from
 * GitHub/nodejs.org (blocked on locked-down/corporate networks).
 *
 * Requires Node >= 20 (uses the stable SEA blob format). Builds a binary for the
 * CURRENT OS only — run this on each OS (or in per-OS CI) to produce all three.
 *
 *   node build-sea.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import esbuild from "esbuild";
import { inject } from "postject";

const OUT = "dist";
mkdirSync(OUT, { recursive: true });

const platform = process.platform;
const isWin = platform === "win32";
const isMac = platform === "darwin";
const outName = isWin ? "devaccel-daemon-win.exe" : isMac ? "devaccel-daemon-macos" : "devaccel-daemon-linux";
const outBin = join(OUT, outName);
const bundle = join(OUT, "bundle.cjs");
const blob = join(OUT, "sea-prep.blob");
const seaConfig = join(OUT, "sea-config.json");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// 1. Bundle cli.js + its local requires (server/fs/config) into one CJS file so
//    the SEA binary is self-contained.
console.log("• bundling cli.js → bundle.cjs");
await esbuild.build({
  entryPoints: ["cli.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: bundle,
  logLevel: "warning",
});

// 2. Write the SEA config and generate the preparation blob.
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
console.log("• generating SEA blob");
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Copy the local Node binary → target, then inject the blob into it.
//    Windows won't let you OVERWRITE a running .exe, but it WILL let you RENAME
//    it. If a daemon is currently running from dist, move the old exe aside so
//    the build can write a fresh one (the running process keeps using the old
//    file). Best-effort cleanup of previous ".old-*" leftovers first.
try {
  for (const f of readdirSync(OUT)) {
    if (f.startsWith(`${outName}.old-`)) {
      try { rmSync(join(OUT, f), { force: true }); } catch { /* still running — leave it */ }
    }
  }
} catch { /* dist not readable yet */ }

if (existsSync(outBin)) {
  try {
    copyFileSync(process.execPath, outBin); // fast path: not locked
  } catch (e) {
    if (e && e.code === "EBUSY") {
      // Locked by a running daemon — rename it aside, then write fresh.
      renameSync(outBin, join(OUT, `${outName}.old-${Date.now()}`));
      copyFileSync(process.execPath, outBin);
      console.log("  (a daemon was running from dist — replaced the binary; restart it to pick up changes)");
    } else {
      throw e;
    }
  }
} else {
  copyFileSync(process.execPath, outBin);
}
console.log(`• copied node → ${outName}`);

// macOS: the copied Node binary is code-signed; injecting into it invalidates
// the signature and the OS kills the binary on launch (always on Apple
// Silicon). Per the Node SEA docs: strip the signature BEFORE injection and
// ad-hoc re-sign AFTER.
if (isMac) {
  execFileSync("codesign", ["--remove-signature", outBin], { stdio: "inherit" });
  console.log("• removed code signature (pre-injection)");
}

console.log("• injecting blob (postject)");
await inject(outBin, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: SENTINEL,
  ...(isMac ? { machoSegmentName: "NODE_SEA" } : {}),
});

if (isMac) {
  execFileSync("codesign", ["--sign", "-", outBin], { stdio: "inherit" });
  console.log("• ad-hoc re-signed (post-injection)");
}

// 4. Windows: flip the PE subsystem from CONSOLE (3) → GUI (2) so launching the
//    exe (double-click OR command) never allocates a console window — install,
//    serve, and uninstall all run silently in the background. The daemon needs
//    no stdin/stdout, so this is safe; dev (`node cli.js`) is unaffected since
//    only the packaged binary is patched. Done AFTER inject so postject can't
//    undo it. Guarded: only flips a genuine console PE with a valid signature.
if (isWin) {
  const exe = readFileSync(outBin);
  const peOff = exe.readUInt32LE(0x3c); // e_lfanew → PE header offset
  const validPe =
    peOff > 0 && peOff + 0x5e <= exe.length &&
    exe[peOff] === 0x50 && exe[peOff + 1] === 0x45 &&
    exe[peOff + 2] === 0x00 && exe[peOff + 3] === 0x00; // "PE\0\0"
  const subOff = peOff + 0x5c; // Optional Header → Subsystem (same for PE32/PE32+)
  if (validPe && exe.readUInt16LE(subOff) === 3 /* WINDOWS_CUI */) {
    exe.writeUInt16LE(2 /* WINDOWS_GUI */, subOff);
    writeFileSync(outBin, exe);
    console.log("• patched PE subsystem → GUI (no console window on launch)");
  } else {
    console.log("• PE subsystem patch skipped (not a console PE or already GUI)");
  }
}

console.log(`\n✔ Built ${outBin}`);
console.log(`  Test it:  ${isWin ? outBin.replace(/\//g, "\\") : "./" + outBin} status`);
