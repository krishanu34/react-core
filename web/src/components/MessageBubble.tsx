"use client";

import { FileText, Sparkles } from "lucide-react";
import type { ChatMessage } from "./Chat";
import { MarkdownContent } from "./MarkdownContent";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const hasAttachments =
    !!message.attachments && message.attachments.length > 0;
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isUser) {
    return (
      <div className="flex w-full justify-end" role="listitem">
        <div className="flex max-w-[85%] flex-col gap-2 rounded-[var(--radius-bell-lg)] bg-bell-blue px-4 py-3 text-[15px] leading-relaxed text-white shadow-[var(--shadow-bell-sm)] sm:max-w-[70%]">
          {message.content && (
            <p className="whitespace-pre-wrap break-words">
              {message.content}
            </p>
          )}
          {hasAttachments && (
            <ul
              className={`flex flex-wrap gap-2 border-white/25 ${
                message.content ? "border-t pt-2" : ""
              }`}
            >
              {message.attachments!.map((att) => (
                <li
                  key={att.id}
                  className="flex items-center gap-2 rounded-[var(--radius-bell)] bg-white/15 px-2 py-1 text-xs text-white"
                >
                  <FileText size={14} aria-hidden />
                  <span className="max-w-[220px] truncate" title={att.name}>
                    {att.name}
                  </span>
                  <span className="opacity-75">{formatBytes(att.size)}</span>
                </li>
              ))}
            </ul>
          )}
          <span className="text-[11px] text-white/70">{time}</span>
        </div>
      </div>
    );
  }

  // Assistant: a wider "document card" so markdown, tables and code fit nicely.
  return (
    <article
      role="listitem"
      className="flex w-full max-w-full flex-col gap-3 rounded-[var(--radius-bell-lg)] border border-bell-border bg-bell-surface p-5 shadow-[var(--shadow-bell-sm)]"
    >
      <header className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-bell-slate">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bell-blue-soft text-bell-blue">
          <Sparkles size={12} aria-hidden />
        </span>
        Assistant
        <span className="ml-auto font-normal normal-case text-bell-muted">
          {time}
        </span>
      </header>

      {message.content && <MarkdownContent content={message.content} />}

      {hasAttachments && (
        <ul className="flex flex-wrap gap-2 border-t border-bell-border pt-2">
          {message.attachments!.map((att) => (
            <li
              key={att.id}
              className="flex items-center gap-2 rounded-[var(--radius-bell)] bg-bell-blue-soft px-2 py-1 text-xs text-bell-blue"
            >
              <FileText size={14} aria-hidden />
              <span className="max-w-[220px] truncate" title={att.name}>
                {att.name}
              </span>
              <span className="text-bell-muted">{formatBytes(att.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
