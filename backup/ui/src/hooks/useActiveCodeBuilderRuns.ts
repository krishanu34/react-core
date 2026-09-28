"use client";

/**
 * useActiveCodeBuilderRuns
 * ========================
 * Tiny polling hook that exposes the list of currently-active Code Builder
 * pipeline runs. Used by:
 *   - The global sidebar to show a "running" badge next to Code Studio.
 *   - The Code Builder page to auto-resume an in-progress run when the
 *     user navigates back from another module.
 *
 * Keeps the polling interval long (15s) when the user is *not* on the
 * Code Builder page so it doesn't pile up requests during normal browsing.
 * The Code Builder page itself does its own faster (3s/10s) polling.
 */
import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth";

export interface ActiveCBRun {
  run_id: string;
  pipeline_type: string;
  project_name: string;
  project_id: number | null;
  output_dir: string;
  started_at: number;
  done: boolean;
  event_count: number;
}

const API_BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

export function useActiveCodeBuilderRuns(intervalMs: number = 15000): {
  runs: ActiveCBRun[];
  runningCount: number;
} {
  const [runs, setRuns] = useState<ActiveCBRun[]>([]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const token = getToken();
        if (!token) {
          if (!cancelled) setRuns([]);
          return;
        }
        const resp = await fetch(`${API_BASE}/sse/runs`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          if (!cancelled) setRuns([]);
          return;
        }
        const data = await resp.json();
        if (!cancelled) setRuns(data.runs || []);
      } catch {
        if (!cancelled) setRuns([]);
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  const runningCount = runs.filter((r) => !r.done).length;
  return { runs, runningCount };
}
