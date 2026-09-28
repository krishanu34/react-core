"use client";

/**
 * Code Builder's accent colour, plus a read-through view of the APP theme.
 *
 * Dark/light is no longer stored here. It used to be its own localStorage key
 * ("cbv2:theme"), which is why toggling the editor left the surrounding app
 * dark (and vice versa). The single source of truth is now lib/theme.ts; this
 * module keeps its original shape so the Code Builder components that read
 * `useCbv2Theme()` did not have to change.
 *
 * - Theme  → lib/theme.ts (localStorage "devsphere:theme", applied to <html>).
 * - Accent → still local, persists under "cbv2:accent" (defaults to #a855f7).
 *
 * Kept dependency-free on purpose; the rest of the app uses Zustand for
 * larger state, but this is one scalar + a custom event.
 */
import { useSyncExternalStore } from "react";
import {
  getTheme,
  setTheme as setAppTheme,
  subscribeTheme,
  toggleTheme as toggleAppTheme,
  type ThemeMode,
} from "@/lib/theme";

export type CbvTheme = ThemeMode;

const ACCENT_KEY = "cbv2:accent";
const DEFAULT_ACCENT = "#a855f7";
const DEFAULT_THEME: CbvTheme = "dark";
const EVENT = "cbv2-theme-change";

interface State {
  theme: CbvTheme;
  accent: string;
}

let accent = DEFAULT_ACCENT;
let hydrated = false;
/** Cached so getSnapshot returns a stable reference between changes —
 *  a fresh object every call makes useSyncExternalStore loop forever. */
let snapshot: State = { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT };

// Stable reference for getServerSnapshot, for the same reason.
const SERVER_SNAPSHOT: State = { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT };

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const a = window.localStorage.getItem(ACCENT_KEY);
    if (a && /^#[0-9a-fA-F]{6}$/.test(a)) accent = a;
  } catch {
    /* localStorage may be unavailable (SSR / privacy mode) */
  }
}

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

export const cbv2Theme = {
  get(): State {
    hydrate();
    const theme = getTheme();
    if (snapshot.theme !== theme || snapshot.accent !== accent) {
      snapshot = { theme, accent };
    }
    return snapshot;
  },
  setTheme(theme: CbvTheme): void {
    setAppTheme(theme);
  },
  setAccent(newAccent: string): void {
    hydrate();
    if (!/^#[0-9a-fA-F]{6}$/.test(newAccent) || accent === newAccent) return;
    accent = newAccent;
    try { window.localStorage.setItem(ACCENT_KEY, newAccent); } catch { /* ignore */ }
    emit();
  },
  toggleTheme(): void {
    toggleAppTheme();
  },
  subscribe(cb: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener(EVENT, cb);
    const unsubscribeTheme = subscribeTheme(cb);
    return () => {
      window.removeEventListener(EVENT, cb);
      unsubscribeTheme();
    };
  },
};

/** React hook — re-renders on theme/accent changes. */
export function useCbv2Theme(): State {
  return useSyncExternalStore(
    cbv2Theme.subscribe,
    () => cbv2Theme.get(),
    () => SERVER_SNAPSHOT,
  );
}
