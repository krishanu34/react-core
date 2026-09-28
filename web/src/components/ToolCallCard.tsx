"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { ChatToolCall } from "./Chat";

interface ToolCallCardProps {
  call: ChatToolCall;
}

/**
 * One collapsed-by-default panel per tool invocation.
 * Shows the tool name, running/done/error status, and — on expand — the
 * raw input and result JSON blobs.
 */
export function ToolCallCard({ call }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);

  const isRunning = call.status === "running";
  const isError = call.status === "error";

  return (
    <div
      className="w-full max-w-full self-start rounded-[var(--radius-bell)] border border-bell-border bg-white text-sm text-bell-slate shadow-[var(--shadow-bell-sm)]"
      role="group"
      aria-label={`Tool ${call.tool}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[var(--radius-bell)] px-3 py-2 text-left transition-colors hover:bg-bell-chrome"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-bell-muted" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-bell-muted" aria-hidden />
        )}

        <StatusIcon status={call.status} />

        <span className="flex items-center gap-1">
          <span className="text-xs uppercase tracking-wide text-bell-muted">tool</span>
          <code className="rounded bg-bell-chrome px-1.5 py-0.5 font-mono text-[13px] text-bell-ink">
            {call.tool}
          </code>
        </span>

        {typeof call.index === "number" && (
          <span className="text-[11px] text-bell-muted">#{call.index}</span>
        )}

        <span className="ml-auto text-[11px] text-bell-muted">
          {isRunning ? "running…" : isError ? "error" : "done"}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-bell-border px-3 py-2">
          <Section label="Input">
            <PayloadBlock value={call.input} />
          </Section>
          <Section label="Result">
            {isRunning ? (
              <p className="text-xs italic text-bell-muted">
                Waiting for the tool to finish…
              </p>
            ) : (
              <PayloadBlock value={call.result} />
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: ChatToolCall["status"] }) {
  if (status === "running") {
    return (
      <Loader2
        size={14}
        className="shrink-0 animate-spin text-bell-blue"
        aria-hidden
      />
    );
  }
  if (status === "error") {
    return (
      <AlertCircle size={14} className="shrink-0 text-red-600" aria-hidden />
    );
  }
  return (
    <CheckCircle2 size={14} className="shrink-0 text-emerald-600" aria-hidden />
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-bell-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function PayloadBlock({ value }: { value: unknown }) {
  if (value === undefined || value === null) {
    return <p className="text-xs italic text-bell-muted">(empty)</p>;
  }
  const text =
    typeof value === "string"
      ? value
      : safeStringify(value);

  return (
    <pre className="bell-scroll max-h-72 overflow-auto rounded-[var(--radius-bell)] border border-bell-border bg-bell-chrome p-2 text-[12px] leading-snug text-bell-ink">
      {text}
    </pre>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Small icon re-export so nobody has to import it separately.
export { Wrench };
