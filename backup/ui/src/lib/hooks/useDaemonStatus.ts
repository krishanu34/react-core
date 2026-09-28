"use client";

/**
 * useDaemonStatus — live daemon connection status for the app shell, the
 * Workspace gate and the Daemon Setup page.
 *
 * Works over HTTP (VM) AND HTTPS/localhost: the daemon binds 127.0.0.1 and the
 * browser probes it there in both contexts. Polling uses `quickDetect` (a single
 * request to the primary port) to keep the network tab quiet; the version is
 * fetched only on the disconnected→connected transition (or a manual refresh).
 *
 * ONE shared poll loop, many subscribers. The shell, the workspaces layout and
 * the setup page all want this status; before it was shared, landing on
 * /workspaces/setup started three independent 4s timers hitting the daemon.
 * State lives in this module; the hook just subscribes to it. The loop runs at
 * the shortest interval any live subscriber asked for, and stops entirely when
 * the last one unmounts.
 *
 * Pass `pollMs <= 0` to subscribe passively — you get the current state but
 * contribute no polling (used by routes that shouldn't probe at all, e.g. login).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { agentClient } from "@/lib/fileAccess";
import { markDaemonInstalled, wasDaemonInstalled } from "@/lib/daemon-install-state";

export interface DaemonStatus {
  /** True when the local daemon responds on 127.0.0.1. */
  connected: boolean;
  /** Daemon version (from /health) when connected, else null. */
  version: string | null;
  /** True while the first/forced check is in flight. */
  checking: boolean;
  /**
   * True when a daemon connection ever succeeded from this browser and no
   * uninstall happened since — "installed but maybe stopped" heuristic
   * (see daemon-install-state.ts).
   */
  installed: boolean;
  /** Force a fresh full probe (used by "Check now" and after stop/uninstall). */
  refresh: () => Promise<void>;
}

type StoreState = Pick<DaemonStatus, "connected" | "version" | "checking" | "installed">;

const INITIAL: StoreState = {
  connected: false,
  version: null,
  checking: true,
  installed: false,
};

// Server render has no daemon and no localStorage — a stable frozen snapshot
// keeps useSyncExternalStore's SSR path from looping.
const SERVER_SNAPSHOT: StoreState = Object.freeze({ ...INITIAL, checking: false });

let state: StoreState = INITIAL;
const subscribers = new Set<() => void>();
/** Poll interval requested by each live subscriber (0 = passive). */
const intervals = new Map<symbol, number>();

let timer: number | null = null;
let currentPollMs = 0;
let inFlight = false;
let wasConnected = false;
let focusBound = false;

function setState(patch: Partial<StoreState>): void {
  const next = { ...state, ...patch };
  // Skip no-op updates so subscribers don't re-render on every 4s poll.
  if (
    next.connected === state.connected &&
    next.version === state.version &&
    next.checking === state.checking &&
    next.installed === state.installed
  ) {
    return;
  }
  state = next;
  subscribers.forEach((notify) => notify());
}

async function check(force: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  if (force) setState({ checking: true });
  try {
    const up = force
      ? (await agentClient.discover(true).catch(() => null)) !== null
      : await agentClient.quickDetect().catch(() => false);

    if (up) {
      // A fresh disconnected→connected transition proves the daemon is
      // installed. Deliberately NOT on every successful probe: right after
      // Uninstall the daemon stays alive for ~100ms, and a probe in that
      // window would re-set the flag Uninstall just cleared.
      if (!wasConnected) {
        markDaemonInstalled();
      }
      // Fetch the version only when we just connected or on a forced refresh.
      let version = state.version;
      if (force || !wasConnected) {
        const h = await agentClient.getHealth().catch(() => null);
        version = h?.version ?? null;
      }
      setState({ connected: true, version, installed: true });
      wasConnected = true;
    } else {
      wasConnected = false;
      // Re-read the flag: Uninstall clears it (agentClient.uninstallDaemon),
      // and the panel must fall back from "Start" to "Install".
      setState({ connected: false, version: null, installed: wasDaemonInstalled() });
    }
  } finally {
    inFlight = false;
    setState({ checking: false });
  }
}

const onFocus = () => void check(false);

/** Start/stop/retune the single timer to match the live subscribers. */
function syncTimer(): void {
  const active = [...intervals.values()].filter((ms) => ms > 0);
  const desired = active.length ? Math.min(...active) : 0;

  if (desired === currentPollMs) return;
  currentPollMs = desired;

  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (desired > 0) {
    timer = window.setInterval(() => void check(false), desired);
    if (!focusBound) {
      window.addEventListener("focus", onFocus);
      focusBound = true;
    }
  } else if (focusBound) {
    window.removeEventListener("focus", onFocus);
    focusBound = false;
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => SERVER_SNAPSHOT;

export function useDaemonStatus(pollMs = 4000): DaemonStatus {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [id] = useState(() => Symbol("daemon-status-subscriber"));

  useEffect(() => {
    const loopWasIdle = timer === null;
    intervals.set(id, pollMs);
    syncTimer();
    // Whoever starts the loop kicks off a full probe, so the first paint after
    // a cold mount isn't stale for a whole interval. Subscribers joining a
    // loop that's already running reuse the state it maintains.
    if (pollMs > 0 && loopWasIdle && !inFlight) void check(true);
    return () => {
      intervals.delete(id);
      syncTimer();
    };
  }, [id, pollMs]);

  // localStorage is browser-only — read it after mount, not during render.
  useEffect(() => {
    if (!state.connected) setState({ installed: wasDaemonInstalled() });
  }, []);

  const refresh = useCallback(() => check(true), []);

  return { ...snapshot, refresh };
}
