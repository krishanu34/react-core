/**
 * src/lib/auth.ts
 * Token management and auth utilities for the browser.
 *
 * Storage strategy:
 *  - localStorage: primary client-side storage
 *  - cookie `auth_token`: read by the Next.js proxy for route protection
 *
 * The name is shared, not local to this file: src/proxy.ts gates every route on
 * that cookie, launch-mode.ts reads the same key from localStorage, and the
 * backend falls back to it in workspace_studio/security/auth.py. Renaming it
 * here alone silently logs everyone out — a login that stores a cookie nothing
 * else looks for leaves the proxy bouncing an authenticated user to /login.
 */

import type { LaunchMode } from "./launch-mode";
import { clearExpendable, setItem as storageSet } from "./storage";

const TOKEN_KEY = "auth_token";

// Mirrors the backend's `_user_from_payload` in workspace_studio/security/auth.py.
export interface AuthUser {
  user_id: number;
  username: string;
  role: string;       // 'admin' | 'user'
  roles: string[];    // e.g. ['create_project', 'view_user_story', 'generate_user_story']
  is_admin: boolean;
  launch_mode: LaunchMode;            // 'integrated' when the session came from DevAccel
  devaccel_project_id: number | null; // set only in integrated mode
}

// ── Token storage ─────────────────────────────────────────────────────────

export function setToken(token: string): void {
  // Written as ESSENTIAL: when the origin's storage is full — and chat
  // transcripts fill it routinely, one unbounded key per workspace — this
  // evicts those caches instead of throwing. It used to throw, and the throw
  // landed here, on the one line that must never fail:
  //   "Setting the value of 'auth_token' exceeded the quota"
  // i.e. nobody could sign in because some old workspace's cached transcript
  // was sitting in the way. See lib/storage.ts for the eviction order.
  const stored = storageSet(TOKEN_KEY, token, "essential");

  // Also store in a cookie so middleware can read it (7-day max, adjust as needed)
  const maxAge = 60 * 60 * 8; // 8 hours to match server exp
  document.cookie = `${TOKEN_KEY}=${token}; path=/; max-age=${maxAge}; SameSite=Lax`;
  // Reset the redirect guard so a fresh login session works correctly.
  _redirectingToLogin = false;

  if (!stored && typeof console !== "undefined") {
    // Storage refused the write even after eviction — disabled by policy or
    // private mode, where nothing we delete will help. getToken() falls back to
    // the cookie, so the session still works; say so rather than fail silently.
    console.warn("[auth] localStorage unavailable — session held in the cookie only.");
  }
}

/** The cookie mirror written by setToken, read when localStorage has no copy. */
function readTokenCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${TOKEN_KEY}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  // The cookie is not only for the proxy — it is the fallback mirror for when
  // the localStorage write was refused. Without this, a refused write means
  // every authFetch goes out with no Authorization header while the proxy,
  // which reads the cookie, happily lets the user in: a half-signed-in state
  // that reads to the user as a broken backend.
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? readTokenCookie();
  } catch {
    return readTokenCookie();
  }
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
}

// ── JWT decode (no verification — server already validated) ──────────────

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

// ── Auth state ─────────────────────────────────────────────────────────────

export function getUser(): AuthUser | null {
  const token = getToken();
  if (!token) return null;
  const payload = decodePayload(token);
  if (!payload) return null;
  // Check expiry — do NOT clear the token here.
  // getUser() must be a pure read; only authFetch (non-silent) and logout()
  // should ever call clearToken() to avoid cascading side-effects that
  // redirect the user while they are actively editing a form.
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return null;
  }
  return {
    user_id:  Number(payload.sub),
    username: String(payload.usr ?? ""),
    role:     String(payload.role ?? "user"),
    roles:    (payload.rls as string[]) ?? [],
    is_admin: payload.role === "admin",
    launch_mode: payload.launch_mode === "integrated" ? "integrated" : "standalone",
    devaccel_project_id:
      typeof payload.project_id === "number" ? payload.project_id : null,
  };
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

export function hasRole(roleName: string): boolean {
  const user = getUser();
  if (!user) return false;
  if (user.is_admin) return true;
  return user.roles.includes(roleName);
}

// ── API calls ──────────────────────────────────────────────────────────────

// DevSphere standalone: auth is served by the DevSphere backend (/auth/*),
// same origin as the agent + workspace APIs.
//
// Exported because anything reading account data (the profile page) must talk
// to the service that MINTED the token. Falling back to the DevAccel base
// (NEXT_PUBLIC_API_URL, port 8000) sends a DevSphere JWT to a different
// product's API — the request 404s or 401s and the page renders its error state.
export const DEVSPHERE_API =
  process.env.NEXT_PUBLIC_DEVSPHERE_API_URL ?? "http://localhost:8003";

const API = DEVSPHERE_API;

export async function login(
  username: string,
  password: string
): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Login failed" }));
    throw new Error(err.detail ?? "Login failed");
  }
  const data = await res.json();
  setToken(data.access_token);
  return { token: data.access_token, user: data.user };
}

/**
 * Where to send a user immediately after authenticating.
 *
 * Always through Daemon Setup. Local file access is a prerequisite for every
 * workspace route, so previously the journey was
 * `/` → `/workspaces` → (daemon probe) → `/workspaces/setup` — three hops with a
 * flash of a page the user was about to be bounced off.
 *
 * The `next` param lets Daemon Setup hand straight over once the daemon reports
 * connected, so a returning user with a live daemon doesn't see an extra stop.
 * Navigating to Setup from the sidebar carries no `next`, so it never
 * auto-advances and stays usable for stopping/updating the daemon.
 */
export function postAuthDestination(from?: string | null): string {
  const target = isSafeInternalPath(from) ? (from as string) : "/workspaces";
  if (target === "/" || target.startsWith("/workspaces/setup")) {
    return "/workspaces/setup?next=%2Fworkspaces";
  }
  return `/workspaces/setup?next=${encodeURIComponent(target)}`;
}

/**
 * True for paths we're willing to redirect to after auth.
 *
 * Rejects absolute URLs and protocol-relative ones (`//evil.com`, which the
 * browser treats as an absolute URL) so a crafted `?from=` or `?next=` can't
 * turn the login flow into an open redirect.
 */
export function isSafeInternalPath(path?: string | null): boolean {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\")
  );
}

/** Raised by register() so the form can mark the offending field. */
export class FieldError extends Error {
  constructor(message: string, readonly field?: "username" | "email") {
    super(message);
    this.name = "FieldError";
  }
}

/**
 * Create an account. The backend signs the new user straight in, so this stores
 * the token exactly like login() and the caller can redirect on success.
 *
 * A 409 means the username or email is already registered; the thrown
 * FieldError carries which one so the form can highlight that input.
 */
export async function register(input: {
  username: string;
  email: string;
  password: string;
  full_name?: string;
}): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    // 409 sends {detail: {detail, field}}; 400/422 send a plain string.
    if (detail && typeof detail === "object" && "field" in detail) {
      throw new FieldError(detail.detail ?? "Registration failed", detail.field);
    }
    throw new FieldError(
      typeof detail === "string" ? detail : "Registration failed",
    );
  }
  const data = await res.json();
  setToken(data.access_token);
  return { token: data.access_token, user: data.user };
}

/** Look up the username registered to an email address. */
export async function recoverUsername(email: string): Promise<string> {
  const res = await fetch(`${API}/auth/recover-username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      typeof body?.detail === "string" ? body.detail : "Could not look up that email.",
    );
  }
  return body.username as string;
}

/** Change the signed-in user's password. Requires the current one. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API}/auth/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string" ? body.detail : "Could not change password.",
    );
  }
}

export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    // Fire-and-forget server-side token invalidation — don't block on it
    fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* ignore network errors on logout */ });
  }
  clearToken();

  // Cached transcripts are both the bulk of this origin's storage and the most
  // sensitive thing in it — the same leak the query-cache clear below guards
  // against, in a store that outlives the tab. Dropping them costs nothing:
  // the canonical copies are on the user's machine and in Workspace Studio.
  clearExpendable();

  // Clear ALL cached query data to prevent leakage between user sessions.
  // Dynamic import avoids a circular dependency (query-client → auth → query-client).
  import("./query-client").then(({ queryClient }) => queryClient.clear()).catch(() => {});

  window.location.href = "/login";
}

// ── Authorised fetch helper ────────────────────────────────────────────────

// Prevent multiple concurrent 401 responses from all racing to redirect.
let _redirectingToLogin = false;

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  { silent = false }: { silent?: boolean } = {}
): Promise<Response> {
  // Pre-flight: detect expired token client-side before wasting a round-trip.
  const token = getToken();
  if (token) {
    try {
      const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(base64));
      if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
        if (silent) {
          // Silent background requests must NOT clear the token — the user may
          // still be actively working and a subsequent explicit action should
          // be the one that clears the session and redirects.
          return new Response(JSON.stringify({ detail: "Token expired" }), { status: 401 });
        }
        // Non-silent (user-initiated) request: clear token and redirect once.
        clearToken();
        if (!_redirectingToLogin) {
          _redirectingToLogin = true;
          window.location.href = "/login";
        }
        return new Response(JSON.stringify({ detail: "Token expired" }), { status: 401 });
      }
    } catch {
      // Malformed token — only clear if not silent, for the same reason above.
      if (!silent) clearToken();
    }
  }

  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    if (!silent) {
      // Only clear the token and redirect for explicit user-initiated requests.
      clearToken();
      if (!_redirectingToLogin) {
        _redirectingToLogin = true;
        window.location.href = "/login";
      }
    }
  }
  return res;
}
