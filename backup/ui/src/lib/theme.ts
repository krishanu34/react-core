"use client";

/**
 * theme — the ONE dark/light switch for all of DevSphere AI.
 *
 * Before this there were three independent themes: the app shell (hard-wired
 * dark in the root layout), the workspace IDE (`data-ide-theme`, stored per
 * workspace in its layout blob) and Code Builder v2 (`cbv2:theme`). Toggling
 * one left the others alone, and the signed-out pages had no switch at all.
 *
 * Now a single value lives here and is written to <html> as:
 *   • class="dark" | "light"       — Tailwind's `dark:` variant + app palette
 *   • data-theme                   — the light token overrides in globals.css
 *   • data-cbv2-theme / data-ide-theme — the pre-existing editor palettes,
 *     driven from the same value so the IDE follows the rest of the app
 *   • color-scheme                 — native scrollbars, inputs, form controls
 *
 * Persisted in localStorage; the initial value comes from the OS preference so
 * a first-time visitor gets the theme they already asked their system for.
 * The pre-paint script in app/layout.tsx applies the same rules before React
 * loads, so there is no flash of the wrong theme.
 *
 * Dependency-free (like theme-store.ts) — it is one scalar plus an event.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "devsphere:theme";
const EVENT = "devsphere-theme-change";
const DEFAULT_THEME: ThemeMode = "dark";

let current: ThemeMode = DEFAULT_THEME;
let hydrated = false;

/** The OS preference, used only when the user has never chosen. */
function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) return DEFAULT_THEME;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Write the theme onto <html>. Kept in sync with the script in layout.tsx. */
export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.setAttribute("data-theme", theme);
  // The editor surfaces already ship full light palettes keyed on these two
  // attributes — point them at the global theme instead of their own toggles.
  root.setAttribute("data-cbv2-theme", theme);
  root.setAttribute("data-ide-theme", theme);
  root.style.colorScheme = theme;
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* localStorage can be unavailable (privacy mode) — fall back to the OS */
  }
  current = stored === "light" || stored === "dark" ? stored : systemTheme();
  applyTheme(current);
}

export function getTheme(): ThemeMode {
  hydrate();
  return current;
}

export function setTheme(theme: ThemeMode): void {
  hydrate();
  if (current === theme) return;
  current = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* not persisting is survivable; the session still switches */
  }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

export function subscribeTheme(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, cb);
  // Another tab switching theme should switch this one too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    const next = e.newValue === "light" ? "light" : "dark";
    if (next === current) return;
    current = next;
    applyTheme(next);
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * React hook — re-renders on theme change.
 *
 * The server snapshot is the default theme: the real value lives in
 * localStorage, which the server cannot read. The pre-paint script has already
 * painted the correct theme by then, so this only affects components that
 * branch on the value in their markup (e.g. the toggle's own icon).
 */
export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);
}
