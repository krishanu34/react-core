/**
 * useDaemonStatus — the shared single-poll store.
 *
 * The hook backs the app shell, the workspaces gate and the Daemon Setup page,
 * all of which can be mounted at once on /workspaces/setup. These tests pin the
 * two properties that matter: N subscribers produce ONE poll loop, and a
 * passive subscriber (pollMs = 0) reads state without probing at all.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quickDetect = vi.fn();
const discover = vi.fn();
const getHealth = vi.fn();

vi.mock("@/lib/fileAccess", () => ({
  agentClient: {
    quickDetect: (...a: unknown[]) => quickDetect(...a),
    discover: (...a: unknown[]) => discover(...a),
    getHealth: (...a: unknown[]) => getHealth(...a),
  },
}));

vi.mock("@/lib/daemon-install-state", () => ({
  markDaemonInstalled: vi.fn(),
  wasDaemonInstalled: () => false,
}));

/** Fresh module instance per test — the store is module-level state. */
async function loadHook() {
  vi.resetModules();
  return (await import("@/lib/hooks/useDaemonStatus")).useDaemonStatus;
}

/**
 * Drain pending promises, optionally advancing the poll timer.
 * Testing Library's `waitFor` polls on real timers, which never fire under
 * `vi.useFakeTimers()` — advancing the fake clock is the way to settle here.
 */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  quickDetect.mockReset().mockResolvedValue(true);
  discover.mockReset().mockResolvedValue("http://127.0.0.1:8390");
  getHealth.mockReset().mockResolvedValue({ version: "1.4.2", name: "devaccel" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDaemonStatus", () => {
  it("reports the connected daemon and its version after the initial probe", async () => {
    const useDaemonStatus = await loadHook();
    const { result } = renderHook(() => useDaemonStatus(4000));

    await flush();

    expect(result.current.checking).toBe(false);
    expect(result.current.connected).toBe(true);
    expect(result.current.version).toBe("1.4.2");
    expect(result.current.installed).toBe(true);
  });

  it("runs ONE poll loop no matter how many components subscribe", async () => {
    const useDaemonStatus = await loadHook();
    const shell = renderHook(() => useDaemonStatus(4000));
    const gate = renderHook(() => useDaemonStatus(4000));
    const page = renderHook(() => useDaemonStatus(4000));

    await flush();

    expect(shell.result.current.checking).toBe(false);
    // Exactly one forced probe (discover), not one per subscriber.
    expect(discover).toHaveBeenCalledTimes(1);

    quickDetect.mockClear();
    await flush(4000);
    // …and one lightweight poll per tick, shared by all three.
    expect(quickDetect).toHaveBeenCalledTimes(1);

    // All subscribers see the same state.
    expect(gate.result.current.connected).toBe(true);
    expect(page.result.current.connected).toBe(true);
  });

  it("does not probe for a passive subscriber (pollMs = 0)", async () => {
    const useDaemonStatus = await loadHook();
    renderHook(() => useDaemonStatus(0));

    await flush(10_000);

    expect(discover).not.toHaveBeenCalled();
    expect(quickDetect).not.toHaveBeenCalled();
  });

  it("stops polling once the last active subscriber unmounts", async () => {
    const useDaemonStatus = await loadHook();
    const { result, unmount } = renderHook(() => useDaemonStatus(4000));

    await flush();
    expect(result.current.checking).toBe(false);

    unmount();
    quickDetect.mockClear();
    await flush(12_000);

    expect(quickDetect).not.toHaveBeenCalled();
  });

  it("clears connection state when the daemon goes away", async () => {
    const useDaemonStatus = await loadHook();
    const { result } = renderHook(() => useDaemonStatus(4000));

    await flush();
    expect(result.current.connected).toBe(true);

    quickDetect.mockResolvedValue(false);
    await flush(4000);

    expect(result.current.connected).toBe(false);
    expect(result.current.version).toBeNull();
  });
});
