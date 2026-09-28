/**
 * Post-authentication routing.
 *
 * Sign-in lands on Daemon Setup rather than /workspaces: local file access gates
 * every workspace route, so the old path was
 * `/` → `/workspaces` → (daemon probe) → `/workspaces/setup` — three hops with a
 * flash of a page the user was about to be bounced off.
 *
 * `?from=` and `?next=` are attacker-controllable (anyone can send a crafted
 * /login?from=… link), so the open-redirect guard is pinned here.
 */

import { describe, expect, it } from "vitest";
import { isSafeInternalPath, postAuthDestination } from "@/lib/auth";

describe("isSafeInternalPath", () => {
  it("accepts ordinary internal paths", () => {
    expect(isSafeInternalPath("/workspaces")).toBe(true);
    expect(isSafeInternalPath("/workspaces/12/ide")).toBe(true);
  });

  it("rejects absolute URLs", () => {
    expect(isSafeInternalPath("https://evil.com")).toBe(false);
    expect(isSafeInternalPath("http://evil.com/x")).toBe(false);
  });

  it("rejects protocol-relative URLs", () => {
    // The browser resolves "//evil.com" as an absolute URL — the classic
    // open-redirect bypass of a naive `startsWith("/")` check.
    expect(isSafeInternalPath("//evil.com")).toBe(false);
  });

  it("rejects backslash tricks and non-paths", () => {
    expect(isSafeInternalPath("/\\evil.com")).toBe(false);
    expect(isSafeInternalPath("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalPath("workspaces")).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
    expect(isSafeInternalPath("")).toBe(false);
  });
});

describe("postAuthDestination", () => {
  it("sends a fresh sign-in to Daemon Setup, handing off to workspaces", () => {
    expect(postAuthDestination(null)).toBe("/workspaces/setup?next=%2Fworkspaces");
    expect(postAuthDestination("/")).toBe("/workspaces/setup?next=%2Fworkspaces");
  });

  it("preserves a deep link as the hand-off target", () => {
    expect(postAuthDestination("/workspaces/12/ide")).toBe(
      "/workspaces/setup?next=%2Fworkspaces%2F12%2Fide",
    );
  });

  it("never loops when the user was already headed for Setup", () => {
    expect(postAuthDestination("/workspaces/setup")).toBe(
      "/workspaces/setup?next=%2Fworkspaces",
    );
  });

  it("discards an off-site `from` instead of redirecting to it", () => {
    for (const hostile of ["https://evil.com", "//evil.com", "/\\evil.com"]) {
      expect(postAuthDestination(hostile)).toBe("/workspaces/setup?next=%2Fworkspaces");
    }
  });

  it("always routes through Setup so the daemon is established first", () => {
    for (const from of [null, "/", "/workspaces", "/profile", "/workspaces/9/ide"]) {
      expect(postAuthDestination(from)).toMatch(/^\/workspaces\/setup\?next=/);
    }
  });
});
