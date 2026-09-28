"use strict";

/**
 * server.auth.test.js — session-bound pairing (Story 4).
 * With DEVACCEL_REQUIRE_AUTH on (default), a browser must present a session
 * token + verifyUrl; the daemon introspects it by calling the app back. Here we
 * stand up a mock "app" verify server to drive those paths.
 * Run with: node --test
 */

// Ensure auth is ON for this file's process (default is on, but be explicit).
delete process.env.DEVACCEL_REQUIRE_AUTH;

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { buildServer, _resetState } = require("../server");

const ALLOWED_ORIGIN = "http://172.191.70.202:3002";

async function startDaemon() {
  _resetState();
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Mock app verify endpoint: 200 only when the bearer token equals `validToken`. */
async function startMockApp(validToken) {
  const server = http.createServer((req, res) => {
    const auth = req.headers["authorization"] || "";
    const ok = auth === `Bearer ${validToken}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, user_id: 1 } : { detail: "Invalid token" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test("pair without a session token is rejected (400)", async () => {
  const { base, close } = await startDaemon();
  try {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, "auth_required");
  } finally { await close(); }
});

test("pair with a valid session token succeeds (introspection 200)", async () => {
  const app = await startMockApp("good-session");
  const { base, close } = await startDaemon();
  try {
    // verifyUrl must share the pairing Origin — so make the Origin the mock app.
    const origin = `http://127.0.0.1:${app.port}`;
    // Register that origin as allowed for this call via env override.
    process.env.DEVACCEL_ALLOWED_ORIGINS = origin;
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "good-session", verifyUrl: `${origin}/workspace-api/daemon/verify` }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok((await res.json()).token);
  } finally {
    delete process.env.DEVACCEL_ALLOWED_ORIGINS;
    await close();
    await app.close();
  }
});

test("pair with an invalid session token is rejected (401)", async () => {
  const app = await startMockApp("good-session");
  const { base, close } = await startDaemon();
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    process.env.DEVACCEL_ALLOWED_ORIGINS = origin;
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "WRONG", verifyUrl: `${origin}/workspace-api/daemon/verify` }),
    });
    assert.strictEqual(res.status, 401);
  } finally {
    delete process.env.DEVACCEL_ALLOWED_ORIGINS;
    await close();
    await app.close();
  }
});

test("SSRF guard: verifyUrl on a different origin is rejected (400)", async () => {
  const { base, close } = await startDaemon();
  try {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "x", verifyUrl: "http://attacker.example.com/verify" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, "bad_verify_url");
  } finally { await close(); }
});

test("CLI callers (no Origin) skip introspection and pair directly", async () => {
  const { base, close } = await startDaemon();
  try {
    const res = await fetch(`${base}/pair`, { method: "POST" }); // no Origin header
    assert.strictEqual(res.status, 200);
    assert.ok((await res.json()).token);
  } finally { await close(); }
});
