"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Trash2,
  Sparkles,
  User,
  Bot,
  Loader2,
  Copy,
  Check,
  MessageSquare,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import {
  sendChatMessage,
  connectChatWs,
  getChatSuggestions,
} from "@/lib/code-builder-api";
import type { ChatMessage, PipelineMode } from "@/types/code-builder";
import { PIPELINE_LABELS } from "@/types/code-builder";

/* ── helpers ───────────────────────────────────────────── */
let _msgId = 0;
const nextId = (): string => `msg-${Date.now()}-${++_msgId}`;

/* ─────────────────────────────────────────────────────────
 * Message bubble
 * ───────────────────────────────────────────────────────── */
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className={`group flex gap-2.5 animate-fade-in ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-editor-accent/20 flex items-center justify-center shrink-0 mt-0.5">
          <Bot size={14} className="text-editor-accent" />
        </div>
      )}
      <div className="relative max-w-[85%]">
        <div className={`px-3 py-2 rounded-lg text-[13px] leading-relaxed ${
          isUser
            ? "bg-editor-accent text-white rounded-tr-sm"
            : "bg-editor-active text-editor-fg rounded-tl-sm"
        }`}>
          <pre className="whitespace-pre-wrap font-sans m-0">{msg.content}</pre>
          {msg.isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-editor-accent animate-pulse ml-0.5 align-middle" />
          )}
        </div>
        {!isUser && msg.content && !msg.isStreaming && (
          <button
            onClick={handleCopy}
            className="absolute -bottom-5 right-1 opacity-0 group-hover:opacity-100 transition-opacity
                       flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-gray-400
                       hover:text-gray-200 hover:bg-editor-input"
            title="Copy to clipboard"
          >
            {copied ? <><Check size={11} className="text-emerald-400" /> Copied</> : <><Copy size={11} /> Copy</>}
          </button>
        )}
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-editor-input flex items-center justify-center shrink-0 mt-0.5">
          <User size={14} className="text-gray-400" />
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════
 * MAIN: AIChatPanel — Pure conversational AI assistant
 * ═════════════════════════════════════════════════════════ */
export default function AIChatPanel() {
  const {
    messages,
    addMessage,
    updateLastAssistant,
    isChatStreaming,
    setChatStreaming,
    clearMessages,
    pipelineMode,
    selectedFile,
  } = useStore();

  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* auto-scroll */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  /* load suggestions */
  useEffect(() => {
    getChatSuggestions(pipelineMode)
      .then((d) => setSuggestions(d.suggestions ?? []))
      .catch(() => {});
  }, [pipelineMode]);

  /* ── send chat message ── */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isChatStreaming) return;
    setInput("");

    const userMsg: ChatMessage = {
      id: nextId(), role: "user", content: text, timestamp: new Date().toISOString(),
    };
    addMessage(userMsg);

    const assistantMsg: ChatMessage = {
      id: nextId(), role: "assistant", content: "", timestamp: new Date().toISOString(), isStreaming: true,
    };
    addMessage(assistantMsg);
    setChatStreaming(true);

    try {
      const ws = connectChatWs();
      let opened = false;

      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({
          message: text,
          context: { pipeline_mode: pipelineMode, file_path: selectedFile },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "chunk" && data.content) updateLastAssistant(data.content);
          else if (data.type === "done") { setChatStreaming(false); ws.close(); }
          else if (data.type === "suggestions") setSuggestions(data.suggestions);
          else if (data.type === "error") { updateLastAssistant(`\n\nError: ${data.error}`); setChatStreaming(false); ws.close(); }
        } catch {}
      };

      ws.onerror = async () => {
        if (!opened) {
          try {
            const resp = await sendChatMessage(text, { pipeline_mode: pipelineMode, file_path: selectedFile ?? undefined });
            updateLastAssistant(resp.reply);
            if (resp.suggestions) setSuggestions(resp.suggestions);
          } catch { updateLastAssistant("Failed to get response. Is the backend running?"); }
          setChatStreaming(false);
        }
      };
      ws.onclose = () => setChatStreaming(false);
    } catch {
      try {
        const resp = await sendChatMessage(text, { pipeline_mode: pipelineMode });
        updateLastAssistant(resp.reply);
      } catch { updateLastAssistant("Failed to connect to AI assistant."); }
      setChatStreaming(false);
    }
  }, [input, isChatStreaming, pipelineMode, selectedFile, addMessage, updateLastAssistant, setChatStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* Header */}
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <MessageSquare size={13} className="text-editor-accent" />
          <span>AI Assistant</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded text-gray-400 bg-editor-input">
            {PIPELINE_LABELS[pipelineMode]}
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearMessages}
            className="p-1 rounded hover:bg-editor-active transition-colors"
            title="Clear chat"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <Sparkles size={24} className="mb-3 opacity-20" />
            <p className="text-xs font-medium mb-1">AI Assistant</p>
            <p className="text-[11px] opacity-60 mb-3 text-center px-4">
              Ask questions about code, architecture, or get help with your project
            </p>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 max-w-sm justify-center">
                {suggestions.slice(0, 4).map((s, i) => (
                  <button key={i}
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    className="px-2 py-1 rounded-full text-[10px] bg-editor-input border border-editor-border
                               hover:border-editor-accent text-gray-300 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)
        )}
      </div>

      {/* Input */}
      <div className="p-2 border-t border-editor-border">
        <div className="flex gap-1.5 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything…"
            rows={2}
            className="input-field resize-none min-h-[40px] max-h-[100px] text-[12px]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isChatStreaming}
            className="btn-primary p-2 shrink-0 disabled:opacity-40"
            title="Send (Enter)"
          >
            {isChatStreaming
              ? <Loader2 size={14} className="animate-spin" />
              : <Send size={14} />
            }
          </button>
        </div>
      </div>
    </div>
  );
}
