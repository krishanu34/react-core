"use client";

import { Circle, CheckCircle2, ListChecks, Loader2 } from "lucide-react";
import type { PlanItem } from "@/lib/sse";

interface PlanCardProps {
  items: PlanItem[];
}

/**
 * Live, non-blocking task checklist — rendered from `plan_update` events.
 * Updates in place as the agent revises statuses; never pauses the run.
 */
export function PlanCard({ items }: PlanCardProps) {
  const done = items.filter((it) => it.status === "completed").length;

  return (
    <div
      className="w-full max-w-full self-start rounded-[var(--radius-bell)] border border-bell-border bg-white text-sm text-bell-slate shadow-[var(--shadow-bell-sm)]"
      role="group"
      aria-label="Task plan"
    >
      <div className="flex items-center gap-2 border-b border-bell-border px-3 py-2">
        <ListChecks size={14} className="shrink-0 text-bell-blue" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-bell-slate">
          Plan
        </span>
        <span className="ml-auto text-[11px] text-bell-muted">
          {done}/{items.length} done
        </span>
      </div>

      <ul className="flex flex-col gap-1.5 px-3 py-2">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2">
            <StatusIcon status={it.status} />
            <span
              className={
                it.status === "completed"
                  ? "text-bell-muted line-through"
                  : it.status === "in_progress"
                    ? "font-medium text-bell-ink"
                    : "text-bell-slate"
              }
            >
              {it.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: PlanItem["status"] }) {
  if (status === "completed") {
    return (
      <CheckCircle2
        size={16}
        className="mt-0.5 shrink-0 text-emerald-600"
        aria-hidden
      />
    );
  }
  if (status === "in_progress") {
    return (
      <Loader2
        size={16}
        className="mt-0.5 shrink-0 animate-spin text-bell-blue"
        aria-hidden
      />
    );
  }
  return (
    <Circle size={16} className="mt-0.5 shrink-0 text-bell-muted" aria-hidden />
  );
}
