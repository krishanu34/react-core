"use client";

import { AlertCircle, Bug, Sparkles, StopCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { answerAgent, debugDownloadUrl, stopAgent, streamAgent } from "@/lib/api";
import { loadThreadId, saveThreadId } from "@/lib/thread";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import { QuestionCard } from "./QuestionCard";
import { ToolCallCard } from "./ToolCallCard";

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  createdAt: number;
}

interface ChatQuestion {
  kind: "question";
  id: string;
  callId: string;
  question: string;
  options?: string[];
  items?: string[];
  checkpoint?: string;
  createdAt: number;
  answered?: string;
}

interface ChatError {
  kind: "error";
  id: string;
  content: string;
  createdAt: number;
}

interface ChatMessageItem extends ChatMessage {
  kind: "message";
}

type ChatItem = ChatMessageItem | ChatQuestion | ChatError | ChatToolCall;

export interface ChatToolCall {
  kind: "tool_call";
  id: string;
  tool: string;
  index?: number;
  input: unknown;
  result: unknown;
  status: "running" | "done" | "error";
  createdAt: number;
}

type Status = "idle" | "streaming" | "awaiting_answer";

const STARTER_PROMPTS = [
  "Design test scenarios for a checkout flow with card and wallet payments.",
  "Generate functional test cases from the requirement I paste.",
  "Draft a Playwright automation skeleton for login and 2FA.",
  "Summarise acceptance criteria from JIRA-1234 and propose edge cases.",
];

interface ChatProps {
  /** Notified whenever the thread id changes so the parent can wire other panes. */
  onThreadIdChange?: (threadId: string | null) => void;
  /** Notified on every SSE `final` event so the parent can refresh the file tree. */
  onRunFinished?: () => void;
}

export function Chat({ onThreadIdChange, onRunFinished }: ChatProps = {}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    setThreadId(loadThreadId());
  }, []);

  useEffect(() => {
    onThreadIdChange?.(threadId);
  }, [threadId, onThreadIdChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items, status, activeTool]);

  const appendItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const appendAssistantContent = useCallback((chunk: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "message" && last.role === "assistant") {
        const merged: ChatMessageItem = {
          ...last,
          content: last.content ? `${last.content}\n\n${chunk}` : chunk,
        };
        return [...prev.slice(0, -1), merged];
      }
      return [
        ...prev,
        {
          kind: "message",
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: chunk,
          createdAt: Date.now(),
        },
      ];
    });
  }, []);

  async function consumeStream(iter: AsyncGenerator<unknown>) {
    for await (const raw of iter) {
      const ev = raw as { type: string; [k: string]: unknown };
      switch (ev.type) {
        case "thread_id": {
          const tid = ev.thread_id as string;
          setThreadId(tid);
          saveThreadId(tid);
          break;
        }
        case "thinking": {
          setActiveTool(null);
          break;
        }
        case "tool_start": {
          const tool = (ev.tool as string) ?? "unknown";
          const index =
            typeof ev.index === "number" ? (ev.index as number) : undefined;
          setActiveTool(tool);
          appendItem({
            kind: "tool_call",
            id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            tool,
            index,
            input: ev.input,
            result: null,
            status: "running",
            createdAt: Date.now(),
          });
          break;
        }
        case "tool_result": {
          const tool = (ev.tool as string) ?? "unknown";
          const index =
            typeof ev.index === "number" ? (ev.index as number) : undefined;
          const result = ev.result;
          const hasError =
            !!result &&
            typeof result === "object" &&
            "error" in (result as Record<string, unknown>);
          setItems((prev) => updateLastToolCall(prev, tool, index, result, hasError));
          setActiveTool(null);
          break;
        }
        case "user_question": {
          const callId = ev.call_id as string;
          pendingCallIdRef.current = callId;
          appendItem({
            kind: "question",
            id: `q-${callId}`,
            callId,
            question: (ev.question as string) ?? "Please provide input.",
            options: ev.options as string[] | undefined,
            createdAt: Date.now(),
          });
          setStatus("awaiting_answer");
          setActiveTool(null);
          break;
        }
        case "checkpoint_request": {
          const callId = ev.call_id as string;
          pendingCallIdRef.current = callId;
          appendItem({
            kind: "question",
            id: `cp-${callId}`,
            callId,
            question: (ev.summary as string) ?? "Please review and approve.",
            options: (ev.options as string[] | undefined) ?? [
              "approve",
              "revise",
              "reject",
            ],
            items: ev.items as string[] | undefined,
            checkpoint: ev.checkpoint as string | undefined,
            createdAt: Date.now(),
          });
          setStatus("awaiting_answer");
          setActiveTool(null);
          break;
        }
        case "final": {
          const answer = (ev.answer as string) ?? "";
          if (answer) appendAssistantContent(answer);
          onRunFinished?.();
          break;
        }
        case "stopped": {
          const reason = (ev.reason as string) ?? "Stopped.";
          appendItem({
            kind: "error",
            id: `stop-${Date.now()}`,
            content: `Run stopped: ${reason}`,
            createdAt: Date.now(),
          });
          break;
        }
        case "error": {
          const errMsg = (ev.error as string) ?? "Unknown error.";
          appendItem({
            kind: "error",
            id: `err-${Date.now()}`,
            content: errMsg,
            createdAt: Date.now(),
          });
          break;
        }
        case "done":
          // Server has closed the stream — outer finally will reset status.
          break;
        default:
          // terminal_output and tool payloads are ignored in the MVP UI.
          break;
      }
    }
  }

  async function startTurn({
    text,
    attachments,
  }: {
    text: string;
    attachments: File[];
  }) {
    if (status !== "idle") return;

    const now = Date.now();
    const userMsg: ChatMessageItem = {
      kind: "message",
      id: `u-${now}`,
      role: "user",
      content: text,
      attachments: attachments.map((f, i) => ({
        id: `${now}-${i}`,
        name: f.name,
        size: f.size,
        type: f.type,
      })),
      createdAt: now,
    };
    appendItem(userMsg);

    setStatus("streaming");
    setActiveTool(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const iter = streamAgent({
        message: text || describeAttachments(attachments),
        threadId,
        files: attachments,
        signal: controller.signal,
      });
      await consumeStream(iter);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        appendItem({
          kind: "error",
          id: `err-${Date.now()}`,
          content: (err as Error).message ?? "Network error.",
          createdAt: Date.now(),
        });
      }
    } finally {
      abortRef.current = null;
      setActiveTool(null);
      setStatus((s) => (s === "awaiting_answer" ? s : "idle"));
    }
  }

  async function submitAnswer(answer: string) {
    const tid = threadId;
    const callId = pendingCallIdRef.current;
    if (!tid || !callId) return;

    setItems((prev) =>
      prev.map((it) =>
        it.kind === "question" && it.callId === callId
          ? { ...it, answered: answer }
          : it,
      ),
    );

    try {
      await answerAgent(tid, callId, answer);
      pendingCallIdRef.current = null;
      setStatus("streaming");
    } catch (err) {
      appendItem({
        kind: "error",
        id: `err-${Date.now()}`,
        content: `Failed to submit answer: ${(err as Error).message}`,
        createdAt: Date.now(),
      });
      setStatus("streaming");
    }
  }

  async function handleStop() {
    const tid = threadId;
    if (!tid) return;
    try {
      await stopAgent(tid);
    } catch {
      // best-effort; server may already be done
    }
    abortRef.current?.abort();
  }

  function pickStarter(prompt: string) {
    if (status !== "idle") return;
    startTurn({ text: prompt, attachments: [] });
  }

  const isEmpty = items.length === 0;
  const inputDisabled = status !== "idle";
  const lastItem = items[items.length - 1];
  const lastIsRunningTool =
    !!lastItem && lastItem.kind === "tool_call" && lastItem.status === "running";
  const showThinking =
    status === "streaming" &&
    !isLastItemAssistantWithContent(items) &&
    !lastIsRunningTool;

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 overflow-hidden px-4 py-6 sm:px-6">
      <div
        ref={scrollRef}
        className="bell-scroll min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-bell-lg)] border border-bell-border bg-bell-surface p-4 shadow-[var(--shadow-bell-sm)] sm:p-6"
        role="list"
        aria-label="Conversation"
      >
        {isEmpty ? (
          <EmptyState onPick={pickStarter} />
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((it) => {
              if (it.kind === "message") {
                return <MessageBubble key={it.id} message={it} />;
              }
              if (it.kind === "question") {
                return (
                  <QuestionCard
                    key={it.id}
                    question={it.question}
                    options={it.options}
                    items={it.items}
                    checkpoint={it.checkpoint}
                    disabled={!!it.answered}
                    onSubmit={submitAnswer}
                  />
                );
              }
              if (it.kind === "tool_call") {
                return <ToolCallCard key={it.id} call={it} />;
              }
              return <ErrorBubble key={it.id} content={it.content} />;
            })}
            {showThinking && <TypingIndicator tool={activeTool} />}
          </div>
        )}
      </div>

      {status !== "idle" && (
        <div className="flex items-center justify-between rounded-[var(--radius-bell)] border border-bell-border bg-white px-3 py-2 text-xs text-bell-slate">
          <span>
            {status === "awaiting_answer"
              ? "Waiting for your input at the checkpoint above."
              : "Working…"}
          </span>
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center gap-1 rounded-[var(--radius-bell-pill)] border border-bell-border px-3 py-1 text-xs font-medium text-bell-slate transition-colors hover:border-bell-blue hover:text-bell-blue"
          >
            <StopCircle size={14} aria-hidden />
            Stop
          </button>
        </div>
      )}

      {threadId && !isEmpty && (
        <div className="flex items-center justify-between text-xs text-bell-muted">
          <span>
            thread:{" "}
            <code className="rounded bg-white px-1 text-bell-slate">
              {threadId.slice(0, 12)}…
            </code>
          </span>
          <a
            href={debugDownloadUrl(threadId)}
            target="_blank"
            rel="noopener noreferrer"
            download={`debug-${threadId}.json`}
            className="inline-flex items-center gap-1 rounded-[var(--radius-bell-pill)] border border-bell-border px-3 py-1 font-medium text-bell-slate transition-colors hover:border-bell-blue hover:text-bell-blue"
          >
            <Bug size={12} aria-hidden />
            Debug JSON
          </a>
        </div>
      )}

      <ChatInput onSubmit={startTurn} disabled={inputDisabled} />
    </section>
  );
}

function isLastItemAssistantWithContent(items: ChatItem[]): boolean {
  const last = items[items.length - 1];
  return (
    !!last &&
    last.kind === "message" &&
    last.role === "assistant" &&
    !!last.content
  );
}

function updateLastToolCall(
  items: ChatItem[],
  tool: string,
  index: number | undefined,
  result: unknown,
  isError: boolean,
): ChatItem[] {
  // Walk from the end so parallel tool_results match the correct start.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (
      it.kind === "tool_call" &&
      it.status === "running" &&
      it.tool === tool &&
      it.index === index
    ) {
      const updated: ChatToolCall = {
        ...it,
        result,
        status: isError ? "error" : "done",
      };
      return [...items.slice(0, i), updated, ...items.slice(i + 1)];
    }
  }
  // No matching start (out-of-order result). Append a synthetic completed
  // card so the user still sees what happened.
  return [
    ...items,
    {
      kind: "tool_call",
      id: `tc-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tool,
      index,
      input: undefined,
      result,
      status: isError ? "error" : "done",
      createdAt: Date.now(),
    },
  ];
}

function describeAttachments(files: File[]): string {
  if (files.length === 0) return "";
  return `I've attached ${files.length} file${
    files.length > 1 ? "s" : ""
  }: ${files.map((f) => f.name).join(", ")}.`;
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bell-blue-soft text-bell-blue">
        <Sparkles size={24} aria-hidden />
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-bell-ink sm:text-3xl">
          Start a conversation
        </h1>
        <p className="mt-2 text-sm text-bell-slate sm:text-base">
          Attach requirements, paste a Jira link, or describe the feature you
          want tested. Bell TAG Engine will plan, design and generate the QA
          artefacts — pausing at each checkpoint for your review.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-[var(--radius-bell-lg)] border border-bell-border bg-bell-surface p-3 text-left text-sm text-bell-slate transition-colors hover:border-bell-blue hover:bg-bell-blue-soft hover:text-bell-blue"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function TypingIndicator({ tool: _tool }: { tool: string | null }) {
  // Tool activity is now shown as inline ToolCallCard entries. This
  // indicator is only for the "thinking between tool calls" moments.
  return (
    <div
      className="flex items-center gap-2 self-start rounded-[var(--radius-bell-lg)] border border-bell-border bg-bell-surface px-4 py-3 text-bell-muted shadow-[var(--shadow-bell-sm)]"
      aria-live="polite"
      aria-label="Assistant is thinking"
    >
      <Dot delay={0} />
      <Dot delay={150} />
      <Dot delay={300} />
      <span className="ml-1 text-xs">Thinking…</span>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-2 w-2 animate-pulse rounded-full bg-bell-blue"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function ErrorBubble({ content }: { content: string }) {
  return (
    <div
      className="flex items-start gap-2 self-start rounded-[var(--radius-bell-lg)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
  );
}
