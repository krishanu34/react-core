"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface JobStatus {
  job_id: string;
  job_type?: string;
  project_id?: number | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress_pct: number;
  progress_percent?: number;
  current_stage: string | null;
  stage_detail: string | null;
  files_done: number;
  files_total: number;
  result: Record<string, unknown> | null;
  error_message: string | null;
  error?: string | null;
  submitted_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface UseJobPollOptions {
  interval?: number;
  onComplete?: (status: JobStatus) => void;
  onFail?: (status: JobStatus) => void;
  onCancel?: (status: JobStatus) => void;
}

export function useJobPoll(options: UseJobPollOptions = {}) {
  const { interval = 2000, onComplete, onFail, onCancel } = options;
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const statusUrlRef = useRef<string | null>(null);
  const retriesRef = useRef(0);
  const callbacksRef = useRef({ onComplete, onFail, onCancel });

  useEffect(() => {
    callbacksRef.current = { onComplete, onFail, onCancel };
  }, [onComplete, onFail, onCancel]);

  const stopPolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setIsPolling(false);
  }, []);

  const poll = useCallback(async function runPoll() {
    if (!statusUrlRef.current) return;
    try {
      const response = await authFetch(statusUrlRef.current);
      if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
      const data = (await response.json()) as JobStatus;
      setStatus(data);
      setError(null);
      retriesRef.current = 0;

      if (data.status === "completed") {
        stopPolling();
        callbacksRef.current.onComplete?.(data);
        return;
      }
      if (data.status === "failed") {
        stopPolling();
        callbacksRef.current.onFail?.(data);
        return;
      }
      if (data.status === "cancelled") {
        stopPolling();
        callbacksRef.current.onCancel?.(data);
        return;
      }
      timerRef.current = setTimeout(runPoll, interval);
    } catch (cause) {
      retriesRef.current += 1;
      setError(cause instanceof Error ? cause.message : "Unknown polling error");
      if (retriesRef.current >= 10) {
        stopPolling();
        return;
      }
      const backoff = Math.min(interval * 2 ** retriesRef.current, 30000);
      timerRef.current = setTimeout(runPoll, backoff);
    }
  }, [interval, stopPolling]);

  const startPolling = useCallback(
    (jobId: string, statusUrl: string) => {
      stopPolling();
      jobIdRef.current = jobId;
      statusUrlRef.current = statusUrl;
      retriesRef.current = 0;
      setStatus(null);
      setError(null);
      setIsPolling(true);
      timerRef.current = setTimeout(poll, 0);
    },
    [poll, stopPolling],
  );

  const cancel = useCallback(async () => {
    if (!jobIdRef.current) return;
    const response = await authFetch(
      `${API}/api/v1/jobs/${encodeURIComponent(jobIdRef.current)}/cancel`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error(`Cancel failed: ${response.status}`);
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  return { status, isPolling, error, startPolling, stopPolling, cancel };
}
