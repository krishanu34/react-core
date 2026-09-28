"use client";

import { CheckSquare, HelpCircle } from "lucide-react";
import { FormEvent, useState } from "react";

interface QuestionCardProps {
  question: string;
  options?: string[];
  items?: string[];
  checkpoint?: string;
  disabled?: boolean;
  onSubmit: (answer: string) => void;
}

export function QuestionCard({
  question,
  options,
  items,
  checkpoint,
  disabled = false,
  onSubmit,
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
    <div className="self-start w-full max-w-[85%] rounded-[var(--radius-bell-lg)] border-l-4 border-bell-accent bg-white shadow-[var(--shadow-bell-md)] sm:max-w-[75%]">
      <div className="flex items-center justify-between gap-2 border-b border-bell-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-bell-slate">
        <span className="flex items-center gap-2">
          {isApproval ? (
            <CheckSquare size={14} className="text-bell-blue" aria-hidden />
          ) : (
            <HelpCircle size={14} className="text-bell-blue" aria-hidden />
          )}
          {isApproval
            ? `Checkpoint · ${checkpoint} — approval needed`
            : "Checkpoint — your input needed"}
        </span>
      </div>

      <p className="whitespace-pre-wrap break-words px-4 py-3 text-[15px] leading-relaxed text-bell-ink">
        {question}
      </p>

      {items && items.length > 0 && (
        <ul className="mx-4 mb-3 flex list-disc flex-col gap-1 rounded-[var(--radius-bell)] border border-bell-border bg-bell-chrome px-6 py-3 text-sm text-bell-slate">
          {items.map((it, i) => (
            <li key={`${i}-${it.slice(0, 30)}`} className="leading-snug">
              {it}
            </li>
          ))}
        </ul>
      )}

      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => onSubmit(opt)}
              className="rounded-[var(--radius-bell-pill)] border border-bell-blue px-3 py-1 text-xs font-medium text-bell-blue transition-colors hover:bg-bell-blue hover:text-white disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={handle} className="flex gap-2 border-t border-bell-border px-4 py-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          placeholder={
            isApproval ? "Or type feedback…" : "Type your answer…"
          }
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
