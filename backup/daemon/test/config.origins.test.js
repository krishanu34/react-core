"use strict";

/**
 * config.origins.test.js — origin allowlist matching.
 * A browser's Origin header never carries a trailing slash or uppercase host,
 * so an allowlist entry written as "http://host:3000/" must still match:
 * a mismatch here makes the daemon invisible to that deployment (no CORS
 * header on /health) and fails /pair with 403 forbidden_origin.
 * Run with: node --test
 */

process.env.DEVACCEL_REQUIRE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert");

const cfg = require("../config");
const { buildServer, _resetState } = require("../server");

test("no default allowlist entry has a trailing slash", () => {
  for (const o of cfg.DEFAULT_ALLOWED_ORIGINS) {
    assert.ok(!o.endsWith("/"), `${o} must not end with "/"`);
  }
});

test("env origins match regardless of trailing slash, case or spacing", () => {
  process.env.DEVACCEL_ALLOWED_ORIGINS = " https://App.Example.com/ ,https://other.example.com";
  try {
    assert.ok(cfg.isOriginAllowed("https://app.example.com"));
    assert.ok(cfg.isOriginAllowed("https://other.example.com"));
    assert.ok(!cfg.isOriginAllowed("https://evil.example.com"));
  } finally {
    delete process.env.DEVACCEL_ALLOWED_ORIGINS;
  }
});

test("an allowlisted origin gets CORS headers on /health and can pair", async () => {
  const origin = "http://20.241.202.9:3000";
  _resetState();
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Discovery: without this header the browser blocks the response and the
    // app reports "daemon not connected" even though the daemon is running.
    const health = await fetch(`${base}/health`, { headers: { Origin: origin } });
    assert.strictEqual(health.headers.get("access-control-allow-origin"), origin);

    const paired = await fetch(`${base}/pair`, { method: "POST", headers: { Origin: origin } });
    assert.strictEqual(paired.status, 200);
    assert.ok((await paired.json()).token);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a non-allowlisted origin is still refused", async () => {
  _resetState();
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "http://evil.example.com" },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, "forbidden_origin");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
