import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  CHAT_CACHE_BUDGET,
  clearExpendable,
  fitChatSessions,
  isQuotaError,
  setItem,
} from "@/lib/storage";

/**
 * A localStorage that enforces a byte ceiling, so "the origin is full" is a
 * real condition here rather than a mocked throw.
 */
function installStorage(capacity: number) {
  const data = new Map<string, string>();
  const used = () =>
    [...data.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);

  const store = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    setItem: (k: string, v: string) => {
      const projected = used() - (data.get(k)?.length ?? 0) - (data.has(k) ? k.length : 0) + k.length + v.length;
      if (projected > capacity) {
        const err = new Error(
          `Failed to execute 'setItem' on 'Storage': Setting the value of '${k}' exceeded the quota.`,
        );
        err.name = "QuotaExceededError";
        throw err;
      }
      data.set(k, v);
    },
  };

  vi.stubGlobal("window", { localStorage: store });
  return { data, store };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("isQuotaError", () => {
  it("recognises the Chrome and Firefox spellings", () => {
    const chrome = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    const firefox = Object.assign(new Error("quota"), { name: "NS_ERROR_DOM_QUOTA_REACHED" });
    const legacy = Object.assign(new Error("quota"), { name: "Whatever", code: 22 });

    expect(isQuotaError(chrome)).toBe(true);
    expect(isQuotaError(firefox)).toBe(true);
    expect(isQuotaError(legacy)).toBe(true);
    expect(isQuotaError(new Error("something else"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe("setItem tiers", () => {
  let data: Map<string, string>;

  beforeEach(() => { ({ data } = installStorage(2000)); });

  /*
   * The reported bug, reproduced: cached transcripts fill the origin, then
   * login cannot store its token —
   *   "Setting the value of 'auth_token' exceeded the quota"
   */
  it("evicts expendable caches so an essential write always lands", () => {
    // Sized so the origin is genuinely full: the token does not fit until
    // something is dropped.
    data.set("chat_sessions_1", "x".repeat(1200));
    data.set("chat_sessions_2", "y".repeat(760));

    expect(setItem("auth_token", "jwt-value", "essential")).toBe(true);
    expect(data.get("auth_token")).toBe("jwt-value");
    // Only as much was dropped as the write needed — the fattest key goes first.
    expect(data.has("chat_sessions_1")).toBe(false);
    expect(data.has("chat_sessions_2")).toBe(true);
  });

  it("does not let one cache evict another", () => {
    data.set("chat_sessions_1", "x".repeat(1900));

    expect(setItem("chat_sessions_2", "y".repeat(500))).toBe(false);
    expect(data.get("chat_sessions_1")).toHaveLength(1900);
  });

  it("never evicts another essential value", () => {
    data.set("auth_token", "jwt-value");
    data.set("chat_sessions_1", "x".repeat(1950));

    expect(setItem("ws_sync_client_id", "client-abc", "essential")).toBe(true);
    expect(data.get("auth_token")).toBe("jwt-value");
    expect(data.has("chat_sessions_1")).toBe(false);
  });

  it("clearExpendable drops caches and keeps the session", () => {
    data.set("auth_token", "jwt-value");
    data.set("chat_sessions_1", "x".repeat(100));
    data.set("ws_meta_4", "y".repeat(100));
    data.set("sse_cursor_job9", "42");

    expect(clearExpendable()).toBe(3);
    expect([...data.keys()]).toEqual(["auth_token"]);
  });

  it("reports failure instead of throwing when storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage { throw new Error("blocked by policy"); },
    });
    expect(() => setItem("auth_token", "jwt", "essential")).not.toThrow();
    expect(setItem("auth_token", "jwt", "essential")).toBe(false);
  });
});

describe("fitChatSessions", () => {
  const bigMessage = (i: number) => ({ kind: "text", role: "assistant", text: `${i}:${"z".repeat(2000)}` });

  it("passes small transcripts through untouched", () => {
    const sessions = [{ id: "a", createdAt: 1, messages: [{ kind: "text", text: "hi" }] }];
    const result = fitChatSessions(sessions);

    expect(result.trimmed).toBe(false);
    expect(result.sessions).toBe(sessions);
  });

  it("caps an oversized transcript and keeps the most recent messages", () => {
    const messages = Array.from({ length: 500 }, (_, i) => bigMessage(i));
    const sessions = [{ id: "a", createdAt: 1, messages }];

    const result = fitChatSessions(sessions);

    expect(result.trimmed).toBe(true);
    expect(JSON.stringify(result.sessions).length).toBeLessThanOrEqual(CHAT_CACHE_BUDGET);
    // The tail is what a reload needs; history comes back from disk/server.
    const kept = result.sessions[0].messages as { text: string }[];
    expect(kept[kept.length - 1].text).toBe(messages[499].text);
    expect(kept.length).toBeLessThan(500);
  });

  it("never mutates the caller's array — the full list still goes to the server", () => {
    const messages = Array.from({ length: 500 }, (_, i) => bigMessage(i));
    const sessions = [{ id: "a", createdAt: 1, messages }];

    fitChatSessions(sessions);

    expect(sessions[0].messages).toHaveLength(500);
  });

  it("keeps at least one session when every session is oversized", () => {
    const sessions = Array.from({ length: 6 }, (_, s) => ({
      id: `s${s}`,
      createdAt: s,
      messages: Array.from({ length: 200 }, (_, i) => bigMessage(i)),
    }));

    const result = fitChatSessions(sessions);

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.sessions).length).toBeLessThanOrEqual(CHAT_CACHE_BUDGET);
  });

  /* The whole point: after capping, the token still fits. */
  it("leaves room for the auth token in a realistic origin", () => {
    const { data } = installStorage(5 * 1024 * 1024);
    for (let ws = 1; ws <= 40; ws++) {
      const sessions = [{
        id: `s${ws}`,
        createdAt: ws,
        messages: Array.from({ length: 400 }, (_, i) => bigMessage(i)),
      }];
      const { sessions: cacheable } = fitChatSessions(sessions);
      setItem(`chat_sessions_${ws}`, JSON.stringify(cacheable));
    }

    expect(setItem("auth_token", "jwt-value", "essential")).toBe(true);
    expect(data.get("auth_token")).toBe("jwt-value");
  });
});
