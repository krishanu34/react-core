"use client";

import React, { useState } from "react";
import { CheckCircle2, HelpCircle, Pencil, Play } from "lucide-react";

interface OpenQuestionsCardProps {
  questions: string[];
  suggestedAnswers: string[];
  status: "idle" | "pending" | "answered";
  onSubmit: (answers: Record<string, string>, stage?: string) => void;
  onSkip: () => void;
  stage?: string;
}

export default function OpenQuestionsCard({
  questions,
  suggestedAnswers,
  status,
  onSubmit,
  onSkip,
  stage,
}: OpenQuestionsCardProps) {
  const [editedAnswers, setEditedAnswers] = useState<Record<number, string>>(() => {
    const initial: Record<number, string> = {};
    questions.forEach((_, i) => {
      initial[i] = suggestedAnswers[i] || "";
    });
    return initial;
  });

  // Track which individual questions are being edited
  const [editingIdx, setEditingIdx] = useState<Set<number>>(new Set());
  // Track whether the user has confirmed this card
  const [confirmed, setConfirmed] = useState(false);

  const isResolved = status === "answered" || confirmed;

  const handleAnswerChange = (idx: number, value: string) => {
    setEditedAnswers((prev) => ({ ...prev, [idx]: value }));
  };

  const toggleEdit = (idx: number) => {
    setEditingIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const answers: Record<string, string> = {};
    questions.forEach((_, i) => {
      answers[String(i)] = editedAnswers[i] || "";
    });
    onSubmit(answers, stage);
    setEditingIdx(new Set());
    setConfirmed(true);
  };

  return (
    <div className="rounded-lg border border-cbv2-border bg-cbv2-surface/60 overflow-hidden my-2">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-cbv2-surface border-b border-cbv2-border">
        {isResolved ? (
          <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
        ) : (
          <HelpCircle className="h-4 w-4 text-amber-400 shrink-0" />
        )}
        <span className="text-xs font-semibold text-cbv2-text-primary tracking-wide uppercase">
          {stage ? `${stage} — ` : ""}Open Questions{isResolved ? ` — Confirmed (${questions.length})` : ` — Review Required (${questions.length})`}
        </span>
        {isResolved ? (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-cbv2-text-dim">
            Click <Pencil className="h-2.5 w-2.5 inline" /> to edit any answer
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-400">
            Review answers below, then click Confirm & Continue
          </span>
        )}
      </div>

      {/* Questions list */}
      <div className="divide-y divide-cbv2-border/50">
        {questions.map((question, idx) => {
          const isEditing = editingIdx.has(idx);
          return (
            <div key={idx} className="px-4 py-3">
              {/* Question */}
              <div className="flex items-start gap-2 mb-2">
                <span className="text-[10px] font-bold text-green-400/80 bg-green-400/10 rounded px-1.5 py-0.5 shrink-0 mt-0.5">
                  Q{idx + 1}
                </span>
                <p className="text-xs text-cbv2-text-primary leading-relaxed flex-1">{question}</p>
                <button
                  onClick={() => toggleEdit(idx)}
                  className="shrink-0 p-1 rounded hover:bg-cbv2-surface transition-colors"
                  title={isEditing ? "Done editing" : "Edit answer"}
                >
                  {isEditing ? (
                    <CheckCircle2 className="h-3 w-3 text-green-400" />
                  ) : (
                    <Pencil className="h-3 w-3 text-cbv2-text-dim hover:text-cbv2-text-primary" />
                  )}
                </button>
              </div>

              {/* Answer area */}
              <div className="ml-7">
                {isEditing ? (
                  <div className="relative">
                    <div className="flex items-center gap-1 mb-1">
                      <Pencil className="h-2.5 w-2.5 text-amber-400" />
                      <span className="text-[10px] text-amber-400">Editing — modify the answer below</span>
                    </div>
                    <textarea
                      className="w-full text-xs bg-cbv2-bg/80 border border-amber-400/30 rounded-md px-3 py-2 text-cbv2-text-primary placeholder-cbv2-text-dim focus:outline-none focus:ring-1 focus:ring-amber-400 resize-y min-h-[2.5rem]"
                      value={editedAnswers[idx] ?? ""}
                      onChange={(e) => handleAnswerChange(idx, e.target.value)}
                      placeholder="Type your answer..."
                      rows={3}
                    />
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-cbv2-text-secondary leading-relaxed flex-1">
                      {(() => {
                        const raw = editedAnswers[idx] || suggestedAnswers[idx] || "";
                        if (!raw) return <span className="italic text-cbv2-text-dim">(no answer)</span>;
                        const bullets = raw
                          .split("\n")
                          .map((l: string) => l.replace(/^[-•]\s*/, "").trim())
                          .filter(Boolean);
                        if (bullets.length <= 1) return <p>{raw.replace(/^[-•]\s*/, "").trim()}</p>;
                        return (
                          <ul className="list-disc list-inside space-y-0.5">
                            {bullets.map((b: string, i: number) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirm button — always visible until confirmed */}
      {!isResolved && (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-cbv2-border bg-cbv2-surface/40">
          <span className="text-[10px] text-cbv2-text-dim">
            Edit any answers above if needed, then confirm to continue the pipeline.
          </span>
          <button
            onClick={handleConfirm}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-white bg-green-600 hover:bg-green-500 px-5 py-1.5 rounded-md transition-colors shadow-sm shadow-green-600/20"
          >
            <Play className="h-3 w-3" />
            Confirm &amp; Continue
          </button>
        </div>
      )}
    </div>
  );
}
