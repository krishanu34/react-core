/**
 * Chat run lifecycle — the "is it still working?" contract.
 *
 * A run's status is persisted with the message. A run that never reached a
 * terminal event (tab closed, reload, crash) therefore comes back from storage
 * still marked "running", and nothing can ever finish it: the SSE stream that
 * would have delivered `done` died with the old page. The UI then renders a
 * live working indicator counting up from an hours-old timestamp, so a
 * conversation the user finished yesterday looks like the backend is still
 * grinding on it — the exact complaint this locks down.
 */
import { describe, expect, it } from "vitest";

import { closeInterruptedRun } from "@/components/ide/ChatDock";

const baseRun = {
  kind: "agent-run" as const,
  role: "assistant" as const,
  status: "running" as const,
  runId: "run-1",
  answer: "",
  timeline: [],
  startedAt: Date.now() - 6 * 60 * 60 * 1000, // six hours ago
};

describe("closeInterruptedRun", () => {
  it("closes a run restored as 'running' and flags it interrupted", () => {
    const restored = closeInterruptedRun({ ...baseRun });
    expect(restored).toMatchObject({
      status: "stopped",
      interrupted: true,
      stopRequested: false,
      forcedStop: false,
    });
  });

  it("leaves finished runs untouched", () => {
    for (const status of ["done", "stopped", "error"] as const) {
      const msg = { ...baseRun, status, answer: "hi" };
      expect(closeInterruptedRun(msg)).toBe(msg); // same reference — no rewrite
    }
  });

  it("leaves non-agent messages untouched", () => {
    const text = { kind: "text" as const, role: "user" as const, text: "hello" };
    expect(closeInterruptedRun(text)).toBe(text);
  });

  it("preserves everything else about the run", () => {
    const rich = {
      ...baseRun,
      answer: "partial",
      timeline: [{ kind: "text" as const, text: "partial", done: false }],
      usage: { prompt_tokens: 900, completion_tokens: 334, total_tokens: 1234 },
    };
    const closed = closeInterruptedRun(rich);
    expect(closed).toMatchObject({
      answer: "partial",
      usage: { total_tokens: 1234 },
    });
    expect((closed as typeof rich).timeline).toHaveLength(1);
  });
});
