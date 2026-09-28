"use strict";

/**
 * server.test.js — integration tests for the daemon HTTP API + security.
 * Spins up buildServer() on an ephemeral port and drives it with fetch.
 * Run with: node --test
 */

// These tests exercise file I/O, not session auth — disable introspection so
// /pair issues a token directly. Session-auth is covered in server.auth.test.js.
// node --test isolates each file in its own process, so this env does not leak.
process.env.DEVACCEL_REQUIRE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");

const { buildServer, _resetState } = require("../server");

const ALLOWED_ORIGIN = "http://172.191.70.202:3002";

/** Start the server on an ephemeral port; returns { base, close }. */
async function startServer() {
  _resetState();
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "devaccel-srv-"));
}

async function pair(base, origin = ALLOWED_ORIGIN) {
  const res = await fetch(`${base}/pair`, { method: "POST", headers: { Origin: origin } });
  const body = await res.json();
  return { status: res.status, token: body.token };
}

test("health is reachable without auth", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.name, "devaccel-daemon");
    assert.strictEqual(body.ok, true);
  } finally { await close(); }
});

test("fs ops without a token are rejected (401)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/fs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ root: "/tmp" }),
    });
    assert.strictEqual(res.status, 401);
  } finally { await close(); }
});

test("a disallowed origin cannot pair (403)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "http://evil.example.com" },
    });
    assert.strictEqual(res.status, 403);
  } finally { await close(); }
});

test("CORS preflight returns allow headers for an allowed origin", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/fs/write`, {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(res.headers.get("access-control-allow-methods") || "", /PUT/);
  } finally { await close(); }
});

test("full flow: pair → open → write → read → scan", async () => {
  const { base, close } = await startServer();
  const dir = await tmpDir();
  try {
    const { token } = await pair(base);
    const authed = (extra = {}) => ({
      Authorization: `Bearer ${token}`,
      Origin: ALLOWED_ORIGIN,
      ...extra,
    });

    const openRes = await fetch(`${base}/fs/open`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ root: dir }),
    });
    const { rootId } = await openRes.json();
    assert.ok(rootId);

    const writeRes = await fetch(`${base}/fs/write`, {
      method: "PUT",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ rootId, path: "src/app.py", content: "print(1)" }),
    });
    assert.strictEqual(writeRes.status, 200);

    const readRes = await fetch(
      `${base}/fs/read?rootId=${rootId}&path=${encodeURIComponent("src/app.py")}`,
      { headers: authed() },
    );
    assert.strictEqual((await readRes.json()).content, "print(1)");

    const scanRes = await fetch(`${base}/fs/scan?rootId=${rootId}`, { headers: authed() });
    const { nodes } = await scanRes.json();
    assert.ok(nodes.some((n) => n.path === "src/app.py" && n.type === "file"));

    // Verify the bytes actually hit disk.
    assert.strictEqual(await fsp.readFile(path.join(dir, "src", "app.py"), "utf8"), "print(1)");
  } finally { await close(); }
});

test("open with create:true makes a missing folder", async () => {
  const { base, close } = await startServer();
  const parent = await tmpDir();
  const newDir = path.join(parent, "brand", "new");
  try {
    const { token } = await pair(base);
    const res = await fetch(`${base}/fs/open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ root: newDir, create: true }),
    });
    assert.strictEqual(res.status, 200);
    const st = await fsp.stat(newDir);
    assert.ok(st.isDirectory());
  } finally { await close(); }
});

test("fs/exists reports directories without registering roots", async () => {
  const { base, close } = await startServer();
  const dir = await tmpDir();
  const filePath = path.join(dir, "a.txt");
  await fsp.writeFile(filePath, "x");
  const missing = path.join(dir, "definitely-missing");
  try {
    const { token } = await pair(base);
    const authed = { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" };

    const res = await fetch(`${base}/fs/exists`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ paths: [dir, missing, filePath] }),
    });
    assert.strictEqual(res.status, 200);
    const { exists } = await res.json();
    assert.strictEqual(exists[dir], true);        // real directory
    assert.strictEqual(exists[missing], false);   // missing
    assert.strictEqual(exists[filePath], false);  // a FILE is not a workspace folder

    // Probing must NOT have registered the dir as a root: scanning by its
    // would-be rootId must fail with unknown_root.
    const { rootIdFor } = require("../server");
    const scanRes = await fetch(`${base}/fs/scan?rootId=${rootIdFor(dir)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN },
    });
    assert.strictEqual(scanRes.status, 404);
  } finally { await close(); }
});

test("fs/exists requires a token (401)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/fs/exists`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ paths: ["/tmp"] }),
    });
    assert.strictEqual(res.status, 401);
  } finally { await close(); }
});

test("pick-folder requires a token (401)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/fs/pick-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: "{}",
    });
    assert.strictEqual(res.status, 401);
  } finally { await close(); }
});

test("path traversal is blocked (400)", async () => {
  const { base, close } = await startServer();
  const dir = await tmpDir();
  try {
    const { token } = await pair(base);
    const openRes = await fetch(`${base}/fs/open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ root: dir }),
    });
    const { rootId } = await openRes.json();
    const res = await fetch(
      `${base}/fs/read?rootId=${rootId}&path=${encodeURIComponent("../../../etc/passwd")}`,
      { headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN } },
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, "path_escape");
  } finally { await close(); }
});

/* ── /daemon/stop + /daemon/uninstall — auth gate only (success exits) ────── */

test("daemon/stop and daemon/uninstall without a token are rejected (401)", async () => {
  const { base, close } = await startServer();
  try {
    for (const endpoint of ["/daemon/stop", "/daemon/uninstall"]) {
      const res = await fetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      });
      // The web client MUST see this 401 as a real failure (it re-pairs and
      // retries); the daemon must do nothing lifecycle-wise without a token.
      assert.strictEqual(res.status, 401, `expected 401 for ${endpoint}`);
    }
  } finally { await close(); }
});

/* ── /daemon/update — validation only (success paths exit the process) ────── */

test("daemon/update without a token is rejected (401)", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/daemon/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ url: "https://example.blob.core.windows.net/x/devaccel.exe" }),
    });
    assert.strictEqual(res.status, 401);
  } finally { await close(); }
});

test("daemon/update rejects non-https URLs (400)", async () => {
  const { base, close } = await startServer();
  try {
    const { token } = await pair(base);
    const res = await fetch(`${base}/daemon/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.blob.core.windows.net/x/devaccel.exe" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, "bad_update_url");
  } finally { await close(); }
});

test("daemon/update rejects non-allowlisted hosts (400)", async () => {
  const { base, close } = await startServer();
  try {
    const { token } = await pair(base);
    for (const url of [
      "https://evil.example.com/devaccel.exe",
      "https://blob.core.windows.net.evil.com/devaccel.exe", // suffix spoof
      "not a url",
      "",
    ]) {
      const res = await fetch(`${base}/daemon/update`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(url)}`);
      assert.strictEqual((await res.json()).error, "bad_update_url");
    }
  } finally { await close(); }
});
