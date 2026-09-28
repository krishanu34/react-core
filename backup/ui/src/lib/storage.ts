/**
 * src/lib/storage.ts
 * Quota-aware localStorage with an eviction order.
 *
 * An origin gets ~5 MB of localStorage, shared by everything this app writes.
 * Chat transcripts are the heavy tenant: `chat_sessions_<wsId>` holds every
 * message of every session in a workspace — agent runs, tool calls, spec file
 * contents and all — and there is one such key PER WORKSPACE, never pruned. A
 * user with dozens of workspaces fills the origin on transcripts alone.
 *
 * Once it is full, `setItem` throws for whoever writes NEXT, which is not
 * whoever filled it. In practice that was login:
 *
 *     Failed to execute 'setItem' on 'Storage':
 *     Setting the value of 'auth_token' exceeded the quota.
 *
 * The user could not sign in because a cached transcript from an unrelated
 * workspace had eaten the origin. Every cache writer was already wrapped in
 * `try { … } catch { /* storage full - ignore *\/ }`, so they failed silently
 * and the single unguarded writer — the token — took the blame for all of them.
 *
 * The rule this module enforces: **the auth token is not a cache.** Everything
 * else here is reconstructible — transcripts are canonical on the user's
 * machine (`~/.devaccel/projects/<id>/sessions/sessions.json`) and in Workspace
 * Studio, metadata re-fetches, cursors re-derive — so an ESSENTIAL write evicts
 * EXPENDABLE keys until it fits instead of failing.
 */

export type StorageTier = "essential" | "expendable";

/**
 * Key prefixes holding values with a canonical copy elsewhere. Anything listed
 * here may be deleted at any moment to make room for an essential write, so
 * only add a prefix whose loss costs a re-fetch and nothing more.
 */
const EXPENDABLE_PREFIXES = [
  "chat_sessions_", // transcripts — canonical on the user's machine + Workspace Studio
  "ws_meta_",       // workspace metadata — re-fetched from the API
  "sse_cursor_",    // job-stream resume cursors — the stream replays without one
];

/**
 * Serialized-size ceiling for ONE workspace's transcript cache, in UTF-16 code
 * units (what `String.length` counts — near enough to bytes for a heuristic).
 *
 * This is the fix for the growth itself rather than for its symptom: without a
 * cap, evicting only buys time until the transcripts grow back.
 */
export const CHAT_CACHE_BUDGET = 384 * 1024;

/** Below this, trimming a session's tail stops being worth doing. */
const MIN_MESSAGES_KEPT = 12;

function ls(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Accessing localStorage itself throws when storage is disabled by policy.
    return null;
  }
}

/**
 * Browsers disagree on how a full quota is reported: Chrome/Edge raise
 * `QuotaExceededError` (legacy code 22), Firefox `NS_ERROR_DOM_QUOTA_REACHED`
 * (1014). Duck-typed rather than `instanceof DOMException`, which is not
 * reliable across the jsdom/browser boundary the tests run on.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

export function isExpendable(key: string): boolean {
  return EXPENDABLE_PREFIXES.some((p) => key.startsWith(p));
}

/** Expendable keys, fattest first — evicting those frees room in fewest deletes. */
function expendableKeysBySizeDesc(except?: string): string[] {
  const store = ls();
  if (!store) return [];
  const found: { key: string; size: number }[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || key === except || !isExpendable(key)) continue;
    found.push({ key, size: (store.getItem(key) ?? "").length });
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.key);
}

export function getItem(key: string): string | null {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function removeItem(key: string): void {
  try {
    ls()?.removeItem(key);
  } catch {
    /* nothing to do — the value is already unreachable */
  }
}

/**
 * Write a value, returning whether it landed.
 *
 * `expendable` (the default) never evicts anyone else's data to fit: one cache
 * must not be able to bump another, or two workspaces ping-pong evicting each
 * other on every save. It simply doesn't get written, exactly as the old
 * silent `catch` behaved — but now the caller can tell.
 *
 * `essential` is the escape hatch, and the reason this module exists: it drops
 * expendable keys one at a time, retrying after each, until the value fits.
 */
export function setItem(key: string, value: string, tier: StorageTier = "expendable"): boolean {
  const store = ls();
  if (!store) return false;

  try {
    store.setItem(key, value);
    return true;
  } catch (err) {
    if (!isQuotaError(err) || tier !== "essential") return false;
  }

  for (const victim of expendableKeysBySizeDesc(key)) {
    removeItem(victim);
    try {
      store.setItem(key, value);
      return true;
    } catch (err) {
      if (!isQuotaError(err)) return false;
    }
  }
  return false;
}

/**
 * Drop every expendable key. Used on logout — these caches are both the bulk
 * of the origin's storage AND the most sensitive thing in it, and the session
 * that owned them is over.
 */
export function clearExpendable(): number {
  const store = ls();
  if (!store) return 0;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && isExpendable(key)) keys.push(key);
  }
  keys.forEach(removeItem);
  return keys.length;
}

interface ChatCacheEntry {
  messages?: unknown[];
  createdAt?: number;
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Un-serializable input can never be cached; report it as over any budget
    // so the trim loop drains it and the write is skipped.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Shrink a transcript list to something worth caching.
 *
 * localStorage is the LAST of three tiers (user's machine → Workspace Studio →
 * browser), so trimming here loses nothing: callers hand the FULL list to the
 * server and to disk, and only the browser copy is capped. What a reload needs
 * from this cache is the recent tail — history comes back from the canonical
 * copies — so the oldest messages of the fattest session go first.
 *
 * Returns a defensive copy; the caller's array is never mutated, because the
 * same array is on its way to the server.
 */
export function fitChatSessions<T extends ChatCacheEntry>(
  sessions: T[],
  budget: number = CHAT_CACHE_BUDGET,
): { sessions: T[]; trimmed: boolean } {
  if (!Array.isArray(sessions) || serializedSize(sessions) <= budget) {
    return { sessions, trimmed: false };
  }

  let working = sessions.map((s) => ({
    ...s,
    messages: [...(s.messages ?? [])],
  })) as T[];

  // Shed 25% of the biggest session's oldest messages at a time. Geometric, so
  // it converges in a handful of passes; the guard is belt-and-braces.
  let guard = 0;
  while (serializedSize(working) > budget && guard++ < 200) {
    let target = -1;
    let biggest = -1;
    working.forEach((s, i) => {
      const n = (s.messages ?? []).length;
      if (n === 0) return;
      const bytes = serializedSize(s);
      if (bytes > biggest) {
        biggest = bytes;
        target = i;
      }
    });
    if (target < 0) break; // every session is empty — nothing left to give
    const messages = working[target].messages as unknown[];
    messages.splice(0, Math.max(1, Math.floor(messages.length * 0.25)));
  }

  // Sessions trimmed to nothing are husks in the sidebar. Drop them oldest
  // first, always keeping the newest so a reload still opens onto something.
  if (working.length > 1) {
    const empties = working
      .filter((s) => (s.messages ?? []).length < MIN_MESSAGES_KEPT)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const victim of empties) {
      if (working.length <= 1) break;
      working = working.filter((s) => s !== victim);
      if (serializedSize(working) <= budget) break;
    }
  }

  return { sessions: working, trimmed: true };
}
