"use client";

import { ArrowRight, CheckSquare, FileText, HelpCircle } from "lucide-react";
import { FormEvent, useState } from "react";

interface QuestionCardProps {
  question: string;
  options?: string[];
  items?: string[];
  checkpoint?: string;
  nextAction?: string;
  artefacts?: string[];
  disabled?: boolean;
  onSubmit: (answer: string) => void;
  onOpenArtefact?: (path: string) => void;
}

const OPTION_HINTS: Record<string, string> = {
  approve: "Proceed with what's shown above",
  revise: "Request changes — type them below",
  reject: "Stop and discard this step",
};

export function QuestionCard({
  question,
  options,
  items,
  checkpoint,
  nextAction,
  artefacts,
  disabled = false,
  onSubmit,
  onOpenArtefact,
}: QuestionCardProps) {
  const [text, setText] = useState("");
  const isApproval = !!checkpoint;

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSubmit(text.trim());
    setText("");
  }

  return (
    <div className="w-full max-w-[85%] self-start overflow-hidden rounded-[var(--radius-bell-lg)] border border-bell-border bg-white shadow-[var(--shadow-bell-md)] sm:max-w-[80%]">
      <div className="flex items-center justify-between gap-2 border-b border-bell-border bg-bell-chrome/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-bell-slate">
        <span className="flex items-center gap-2">
          {isApproval ? (
            <CheckSquare size={14} className="text-bell-blue" aria-hidden />
          ) : (
            <HelpCircle size={14} className="text-bell-blue" aria-hidden />
          )}
          {isApproval
            ? `Checkpoint · ${checkpoint} — approval needed`
            : "Your input needed"}
        </span>
        {items && items.length > 0 && (
          <span className="rounded-[var(--radius-bell-pill)] bg-bell-blue-soft px-2 py-0.5 text-[11px] font-medium normal-case text-bell-blue">
            {items.length} item{items.length > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <p className="whitespace-pre-wrap break-words px-4 py-3 text-[15px] leading-relaxed text-bell-ink">
        {question}
      </p>

      {artefacts && artefacts.length > 0 && (
        <div className="mx-4 mb-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-bell-muted">
            Review the draft
          </p>
          <div className="flex flex-wrap gap-2">
            {artefacts.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => onOpenArtefact?.(path)}
                disabled={!onOpenArtefact}
                title={path}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-bell)] border border-bell-border bg-white px-2.5 py-1.5 text-xs text-bell-slate transition-colors hover:border-bell-blue hover:text-bell-blue disabled:cursor-default disabled:opacity-70"
              >
                <FileText size={13} className="shrink-0 text-bell-blue" aria-hidden />
                <span className="max-w-[220px] truncate">{basename(path)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="mx-4 mb-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-bell-muted">
            {isApproval ? "What you're approving" : "Details"}
          </p>
          <ul className="flex list-disc flex-col gap-1 rounded-[var(--radius-bell)] border border-bell-border bg-bell-chrome/60 px-6 py-3 text-sm text-bell-slate">
            {items.map((it, i) => (
              <li key={`${i}-${it.slice(0, 30)}`} className="leading-snug">
                {it}
              </li>
            ))}
          </ul>
        </div>
      )}

      {nextAction && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-[var(--radius-bell)] border border-bell-blue/25 bg-bell-blue-soft px-3 py-2 text-sm text-bell-blue-dark">
          <ArrowRight size={15} className="mt-0.5 shrink-0 text-bell-blue" aria-hidden />
          <span>
            <span className="font-semibold">On approve:</span> {nextAction}
          </span>
        </div>
      )}

      {options && options.length > 0 && (
        <div className="flex flex-col gap-1.5 px-4 pb-3">
          {options.map((opt) => {
            const hint = OPTION_HINTS[opt.toLowerCase()];
            return (
              <button
                key={opt}
                type="button"
                disabled={disabled}
                onClick={() => onSubmit(opt)}
                className="group flex items-center gap-2 rounded-[var(--radius-bell)] border border-bell-border px-3 py-2 text-left transition-colors hover:border-bell-blue hover:bg-bell-blue-soft disabled:opacity-50"
              >
                <span className="text-sm font-medium capitalize text-bell-ink group-hover:text-bell-blue">
                  {opt}
                </span>
                {hint && (
                  <span className="text-xs text-bell-muted">— {hint}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <form onSubmit={handle} className="flex gap-2 border-t border-bell-border px-4 py-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          placeholder={isApproval ? "Or type feedback…" : "Type your answer…"}
          className="flex-1 rounded-[var(--radius-bell)] border border-bell-border bg-white px-3 py-2 text-sm text-bell-ink placeholder:text-bell-muted focus:border-bell-blue focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="rounded-[var(--radius-bell-pill)] bg-bell-blue px-4 text-sm font-medium text-white transition-colors hover:bg-bell-blue-dark disabled:cursor-not-allowed disabled:bg-bell-border disabled:text-bell-muted"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
