"use client";

import { Paperclip, Send, X } from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface PendingAttachment {
  id: string;
  file: File;
}

interface ChatInputProps {
  onSubmit: (payload: { text: string; attachments: File[] }) => void;
  disabled?: boolean;
}

export function ChatInput({ onSubmit, disabled = false }: ChatInputProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea to fit its content up to ~10 lines, then scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 240; // matches max-h-60 below
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  const canSubmit =
    !disabled && (text.trim().length > 0 || pending.length > 0);

  function handleFilesPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setPending((prev) => [
      ...prev,
      ...files.map((f) => ({
        id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
        file: f,
      })),
    ]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      text: text.trim(),
      attachments: pending.map((p) => p.file),
    });
    setText("");
    setPending([]);
    // Return focus to the textarea for rapid follow-ups
    textareaRef.current?.focus();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits, Shift+Enter inserts a newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[var(--radius-bell-lg)] border border-bell-border bg-bell-surface shadow-[var(--shadow-bell-md)] transition-shadow focus-within:border-bell-blue/50 focus-within:shadow-[var(--shadow-bell-lg)]"
    >
      {pending.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-b border-bell-border px-3 pb-2 pt-3">
          {pending.map((att) => (
            <li
              key={att.id}
              className="flex items-center gap-2 rounded-[var(--radius-bell)] bg-bell-blue-soft px-2 py-1 text-xs text-bell-blue"
            >
              <span className="max-w-[240px] truncate" title={att.file.name}>
                {att.file.name}
              </span>
              <span className="text-bell-muted">
                {formatBytes(att.file.size)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${att.file.name}`}
                onClick={() => removeAttachment(att.id)}
                className="rounded-full p-0.5 hover:bg-white/60"
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
          title="Attach files"
          disabled={disabled}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-bell-pill)] text-bell-slate transition-colors hover:bg-bell-chrome hover:text-bell-blue disabled:opacity-50"
        >
          <Paperclip size={20} aria-hidden />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.htm"
          className="hidden"
          onChange={handleFilesPicked}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Describe the QA task, or ask a question…"
          disabled={disabled}
          className="max-h-60 min-h-[40px] flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-[15px] leading-6 text-bell-ink placeholder:text-bell-muted focus:outline-none disabled:opacity-60"
        />

        <button
          type="submit"
          aria-label="Send"
          disabled={!canSubmit}
          className="bell-gradient flex h-10 items-center gap-2 rounded-[var(--radius-bell-pill)] px-4 text-sm font-medium text-white shadow-[var(--shadow-bell-sm)] transition-all hover:brightness-110 hover:shadow-[var(--shadow-bell-md)] disabled:cursor-not-allowed disabled:bg-none disabled:bg-bell-border disabled:text-bell-muted disabled:shadow-none"
        >
          <span className="hidden sm:inline">Send</span>
          <Send size={16} aria-hidden />
        </button>
      </div>

      <p className="border-t border-bell-border px-3 py-1.5 text-[11px] text-bell-muted">
        Press <kbd className="rounded bg-bell-chrome px-1">Enter</kbd> to send,
        <kbd className="ml-1 rounded bg-bell-chrome px-1">Shift + Enter</kbd>{" "}
        for a new line. Supported: PDF · DOCX · TXT · MD · CSV · JSON · HTML.
      </p>
    </form>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
