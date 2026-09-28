"use client";

/**
 * ContextMeter + QuotaBanner — the two things a user needs to see about
 * tokens, and the two the IDE was not showing.
 *
 * The chat used to display ONE number: the cumulative sum of every step's
 * total_tokens. That number is real but answers no question anyone has. An
 * agent run re-sends its whole prompt on every step, so the sum grows
 * superlinearly — a long run on a 128k model happily reports "800k tokens" —
 * and it never reveals the thing that actually matters, which is how much room
 * is left before history gets compressed away.
 *
 * So there are two distinct measurements here, and keeping them apart is the
 * whole design:
 *
 *   ContextMeter  — OCCUPANCY. How full the window is right now, from the
 *                   provider's own prompt_tokens. Goes up and down; drops
 *                   when compaction runs.
 *   Token badge   — SPEND. Cumulative input/output/cached for the turn, which
 *                   is what the bill is made of. Only ever goes up.
 */

import { AlertTriangle, Coins, Info } from "lucide-react";

import { formatCost, formatTokens } from "@/lib/devsphere-models-api";

export interface ContextState {
  used: number;
  window: number;
  pct: number;
  cached: number;
  breakdown: {
    system_and_tools: number;
    memory: number;
    scratchpad: number;
    completion_reserve: number;
  };
}

export interface QuotaNotice {
  level: "warn" | "critical" | "exceeded" | "blocked";
  used: number;
  limit: number | null;
  window: "day" | "month";
  pct: number;
  degraded: boolean;
  model: string | null;
  message: string;
}

// Thresholds match the backend's compaction pressure, not round numbers: past
// ~75% a long tool result can trigger compression on the very next step, and
// that is the point at which a user might want to start a fresh thread.
const AMBER_AT = 75;
const RED_AT = 90;

function toneFor(pct: number) {
  if (pct >= RED_AT) return { arc: "text-red-500", text: "text-red-400" };
  if (pct >= AMBER_AT) return { arc: "text-amber-500", text: "text-amber-400" };
  return { arc: "text-violet-500", text: "text-[var(--ide-muted)]" };
}

// Ring geometry. A circumference constant beats computing it per render, and
// keeping the radius here means the stroke width and the viewBox can't drift
// apart silently.
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Compact context-window gauge for the composer.
 *
 * Renders nothing until the first `context_state` event: an empty meter before
 * the first LLM call would be showing a measurement that doesn't exist yet.
 */
export function ContextMeter({ state }: { state?: ContextState | null }) {
  if (!state || !state.window) return null;

  // Recompute rather than trusting the reported pct: the two must agree with
  // the used/window numbers shown beside them, or the meter reads as broken.
  const rawPct = state.window > 0 ? (state.used / state.window) * 100 : 0;
  const pct = Math.min(rawPct, 100);
  const tone = toneFor(pct);
  const remaining = Math.max(0, state.window - state.used);
  const over = state.used > state.window;

  const title = [
    `Context OCCUPANCY — how full the window was on the last step.`,
    `${state.used.toLocaleString()} of ${state.window.toLocaleString()} tokens (${rawPct.toFixed(1)}%)`,
    `Free: ${remaining.toLocaleString()}`,
    state.cached ? `Served from cache: ${state.cached.toLocaleString()}` : null,
    over ? "OVER the configured window — check the model's context_window." : null,
    "",
    "This is NOT the token total beside it. That is cumulative SPEND across",
    "every step of the turn and only ever grows; this rises and falls with",
    "how much history is currently loaded.",
    "",
    "Budget allocation:",
    `  System + tools: ${formatTokens(state.breakdown.system_and_tools)}`,
    `  History: ${formatTokens(state.breakdown.memory)}`,
    `  Working steps: ${formatTokens(state.breakdown.scratchpad)}`,
    `  Reserved for the reply: ${formatTokens(state.breakdown.completion_reserve)}`,
    "",
    pct >= AMBER_AT
      ? "Nearing the limit — older steps get compressed to make room."
      : "Older steps are compressed automatically when this fills up.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] shrink-0"
      title={title}
      aria-label={`Context window ${pct.toFixed(0)} percent full`}
    >
      {/* A ring rather than a bar: "how full is the window" is a proportion of
          a whole, and a closed shape reads as one at a glance where a 48px
          line does not. -rotate-90 puts 0% at twelve o'clock so it fills
          clockwise the way a dial is expected to. */}
      <svg
        className="h-3.5 w-3.5 shrink-0 -rotate-90"
        viewBox="0 0 16 16"
        role="presentation"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-[var(--ide-border)]"
        />
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          // A floor of 2% keeps a just-started run from rendering as a bare
          // track, which reads as "no measurement" rather than "nearly empty".
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(pct, 2) / 100)}
          className={`stroke-current transition-[stroke-dashoffset] duration-500 ${tone.arc}`}
        />
      </svg>
      {/* The raw numbers, not just a percentage. A bare "3%" next to a
          cumulative token total that reads far higher looks broken; showing
          what the 3% is OF makes the two self-evidently different
          measurements, and makes a mis-configured window visible instead of
          silently shrinking every reading. */}
      <span className={`font-mono ${tone.text}`}>
        {formatTokens(state.used)}<span className="opacity-50">/</span>{formatTokens(state.window)}
      </span>
      {over && (
        <span className="font-mono text-red-400" title="Used more than the configured window">
          !
        </span>
      )}
    </span>
  );
}

/**
 * Per-message token badge: what the turn actually cost.
 *
 * Input and output are split because they price differently and behave
 * differently — input is dominated by history and mostly cacheable, output is
 * what the model wrote. `cached` is shown when the provider served any of the
 * input from its cache, since that is the difference between a long
 * conversation being expensive and being nearly free.
 */
export function TokenBadge({
  usage,
  cost,
}: {
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number };
  cost?: number | null;
}) {
  const cached = usage.cached_tokens ?? 0;
  const cachedPct = usage.prompt_tokens > 0 ? Math.round((cached / usage.prompt_tokens) * 100) : 0;

  const title = [
    `Input: ${usage.prompt_tokens.toLocaleString()}`,
    cached ? `  of which cached: ${cached.toLocaleString()} (${cachedPct}%)` : null,
    `Output: ${usage.completion_tokens.toLocaleString()}`,
    `Total: ${usage.total_tokens.toLocaleString()}`,
    cost != null && cost > 0 ? `Cost: ${formatCost(cost)}` : null,
    "",
    "Cumulative across every step of this turn — the prompt is re-sent each",
    "step, so this exceeds the context window on a long run. See the context",
    "gauge in the composer for how full the window itself is.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <Coins className="h-3 w-3 shrink-0" />
      <span className="font-mono">
        {formatTokens(usage.prompt_tokens)}↑ {formatTokens(usage.completion_tokens)}↓
      </span>
      {cached > 0 && <span className="opacity-70">· {cachedPct}% cached</span>}
      {cost != null && cost > 0 && <span className="opacity-70">· {formatCost(cost)}</span>}
    </span>
  );
}

/**
 * Budget banner.
 *
 * Note what the `exceeded` case says: the run CONTINUES, on a cheaper model.
 * That is the backend's actual behaviour (quota/service.py) and the wording
 * has to match it — a red "budget exhausted" over a run that is still
 * happily working would teach users to ignore the banner entirely.
 */
export function QuotaBanner({ notice, onDismiss }: { notice: QuotaNotice; onDismiss?: () => void }) {
  const tone =
    notice.level === "blocked"
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : notice.level === "exceeded"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : notice.level === "critical"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
          : "border-amber-500/25 bg-amber-500/5 text-amber-200/90";

  const Icon = notice.level === "exceeded" ? Info : AlertTriangle;

  return (
    <div className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${tone}`}>
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="leading-snug">{notice.message}</p>
        {notice.limit != null && (
          <p className="mt-0.5 opacity-70">
            {formatTokens(notice.used)} of {formatTokens(notice.limit)} this {notice.window} ·{" "}
            {notice.pct.toFixed(0)}%
            {notice.degraded && notice.model ? ` · now on ${notice.model}` : ""}
          </p>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100"
          aria-label="Dismiss budget notice"
        >
          ×
        </button>
      )}
    </div>
  );
}
