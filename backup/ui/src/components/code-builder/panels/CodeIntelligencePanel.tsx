"use client";

import { useState, useRef, useCallback } from "react";
import {
  Upload,
  Search,
  Bot,
  Loader2,
  Send,
  Network,
  FileCode2,
  Layers,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { analyzeZip, getGraphSummary, getGraphEntities, searchCode, connectAgent } from "@/lib/code-intel-api";
import type {
  CIAnalysisResult,
  CIGraphSummary,
  CIEntityNode,
  CISearchResult,
  CIAgentMessage,
  CIAgentStatus,
  CIPhase,
} from "@/types/code-intelligence";

/* ── helpers ───────────────────────────────────────────── */
let _msgId = 0;
const nextId = (): string => `ci-msg-${Date.now()}-${++_msgId}`;

/* ─────────────────────────────────────────────────────────
 * Code Intelligence Panel
 *
 * Tabs: Analyze | Graph | Search | Agent
 * ───────────────────────────────────────────────────────── */

type CITab = "analyze" | "graph" | "search" | "agent";

export default function CodeIntelligencePanel({ projectId }: { projectId?: number }) {
  const [activeTab, setActiveTab] = useState<CITab>("analyze");

  const tabs: { key: CITab; label: string; icon: React.ReactNode }[] = [
    { key: "analyze", label: "Analyze", icon: <FileCode2 size={14} /> },
    { key: "graph", label: "Graph", icon: <Network size={14} /> },
    { key: "search", label: "Search", icon: <Search size={14} /> },
    { key: "agent", label: "Agent", icon: <Bot size={14} /> },
  ];

  return (
    <div className="flex flex-col h-full bg-editor-bg text-editor-fg">
      {/* Tab bar */}
      <div className="flex border-b border-editor-border bg-editor-sidebar shrink-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === t.key
                ? "border-editor-accent text-editor-accent"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === "analyze" && <AnalyzeTab projectId={projectId} />}
        {activeTab === "graph" && <GraphTab />}
        {activeTab === "search" && <SearchTab />}
        {activeTab === "agent" && <AgentTab projectId={projectId} />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Analyze Tab — Upload ZIP & run analysis pipeline
 * ───────────────────────────────────────────────────────── */

function AnalyzeTab({ projectId }: { projectId?: number }) {
  const [phase, setPhase] = useState<CIPhase>("idle");
  const [result, setResult] = useState<CIAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setPhase("uploading");
    setError(null);
    setResult(null);

    try {
      setPhase("analyzing");
      const res = await analyzeZip(file, { projectId });
      setResult(res);
      setPhase("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      setPhase("error");
    }
  }, [projectId]);

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs text-gray-400 font-medium">Upload ZIP Archive</label>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.tar.gz,.tgz"
            className="flex-1 text-xs text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0
                       file:text-xs file:font-medium file:bg-editor-accent/20 file:text-editor-accent
                       hover:file:bg-editor-accent/30 cursor-pointer"
          />
          <button
            onClick={handleUpload}
            disabled={phase === "analyzing" || phase === "uploading"}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded
                       bg-editor-accent text-white hover:bg-editor-accent/80
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {phase === "analyzing" || phase === "uploading" ? (
              <><Loader2 size={13} className="animate-spin" /> Analyzing...</>
            ) : (
              <><Upload size={13} /> Analyze</>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-medium">
            <CheckCircle2 size={14} />
            Analysis Complete — {result.project_name}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Files" value={result.total_files} />
            <StatCard label="Entities" value={result.total_entities} />
            <StatCard label="Layers" value={result.layers.length} />
          </div>

          {result.tech_stack.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-gray-400">Tech Stack</span>
              <div className="flex flex-wrap gap-1">
                {result.tech_stack.map((t) => (
                  <span key={t} className="px-2 py-0.5 text-[11px] rounded bg-editor-input text-gray-300">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {result.layers.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-gray-400">Architectural Layers</span>
              <div className="space-y-1">
                {result.layers.map((l) => (
                  <div key={l.layer} className="flex items-center justify-between px-2 py-1.5 rounded bg-editor-input text-xs">
                    <div className="flex items-center gap-1.5">
                      <Layers size={12} className="text-editor-accent" />
                      <span className="text-gray-200">{l.layer}</span>
                    </div>
                    <span className="text-gray-500">{l.entity_count} entities</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Stat card ─────────────────────────────────────────── */
function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-2 rounded bg-editor-input text-center">
      <div className="text-base font-semibold text-editor-fg">{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Graph Tab — View graph summary & browse entities
 * ───────────────────────────────────────────────────────── */

function GraphTab() {
  const [summary, setSummary] = useState<CIGraphSummary | null>(null);
  const [entities, setEntities] = useState<CIEntityNode[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedUids, setExpandedUids] = useState<Set<string>>(new Set());

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getGraphSummary();
      setSummary(s);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEntities = useCallback(async (layer?: string) => {
    setLoading(true);
    try {
      const res = await getGraphEntities(layer ? { layer } : undefined);
      setEntities(res.entities);
      setSelectedLayer(layer ?? null);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleEntity = (uid: string) => {
    setExpandedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={loadSummary}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded
                     bg-editor-input text-gray-300 hover:bg-editor-active transition-colors
                     disabled:opacity-50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
          Load Graph
        </button>
        {selectedLayer && (
          <button
            onClick={() => loadEntities()}
            className="text-xs text-editor-accent hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>

      {summary && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <StatCard label="Nodes" value={summary.total_nodes} />
            <StatCard label="Edges" value={summary.total_edges} />
          </div>

          {summary.node_labels && (
            <div className="space-y-1">
              <span className="text-xs text-gray-400">By Label</span>
              {Object.entries(summary.node_labels).map(([label, count]) => (
                <button
                  key={label}
                  onClick={() => label === "Entity" ? loadEntities() : undefined}
                  className="w-full flex items-center justify-between px-2 py-1 rounded
                             bg-editor-input text-xs hover:bg-editor-active transition-colors"
                >
                  <span className="text-gray-200">{label}</span>
                  <span className="text-gray-500">{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {entities.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-gray-400">
            Entities {selectedLayer && `(${selectedLayer})`} — {entities.length} total
          </span>
          <div className="space-y-0.5 max-h-[400px] overflow-auto">
            {entities.map((e) => (
              <div key={e.uid} className="rounded bg-editor-input">
                <button
                  onClick={() => toggleEntity(e.uid)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left hover:bg-editor-active transition-colors"
                >
                  {expandedUids.has(e.uid) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="text-editor-accent font-mono text-[11px]">{e.entity_type}</span>
                  <span className="text-gray-200 truncate">{e.name}</span>
                </button>
                {expandedUids.has(e.uid) && (
                  <div className="px-6 pb-2 text-[11px] text-gray-400 space-y-0.5">
                    <div>File: <span className="text-gray-300">{e.file_path}</span></div>
                    {e.signature && <div>Signature: <span className="text-gray-300 font-mono">{e.signature}</span></div>}
                    <div className="text-gray-300">{e.summary}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Search Tab — Semantic code search
 * ───────────────────────────────────────────────────────── */

function SearchTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CISearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await searchCode(query);
      setResults(res.results);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search code entities..."
          className="flex-1 px-3 py-1.5 text-xs bg-editor-input border border-editor-border rounded
                     text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-editor-accent"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded
                     bg-editor-accent text-white hover:bg-editor-accent/80
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          Search
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-gray-400">{results.length} results</span>
          {results.map((r) => (
            <div key={r.uid} className="p-2 rounded bg-editor-input text-xs space-y-1 hover:bg-editor-active transition-colors">
              <div className="flex items-center gap-1.5">
                <span className="text-editor-accent font-mono text-[11px]">{r.node_type}</span>
                <span className="text-gray-200 font-medium">{r.name}</span>
                {r.similarity != null && (
                  <span className="ml-auto text-gray-500">{(r.similarity * 100).toFixed(0)}%</span>
                )}
              </div>
              <div className="text-gray-400 text-[11px]">{r.file_path}</div>
              <div className="text-gray-300 text-[11px]">{r.summary}</div>
            </div>
          ))}
        </div>
      )}

      {results.length === 0 && query && !loading && (
        <div className="text-xs text-gray-500 text-center py-4">No results found</div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Agent Tab — Interactive chat with Code Intelligence Agent
 * ───────────────────────────────────────────────────────── */

function AgentTab({ projectId }: { projectId?: number }) {
  const [messages, setMessages] = useState<CIAgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<CIAgentStatus>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || status === "running") return;

    const userMsg: CIAgentMessage = {
      id: nextId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStatus("connecting");

    const ws = connectAgent(
      text,
      {
        onEvent: (ev) => {
          setStatus("running");
          const sysMsg: CIAgentMessage = {
            id: nextId(),
            role: "system",
            content: `[${ev.type}] ${ev.data ? JSON.stringify(ev.data).slice(0, 200) : ""}`,
            timestamp: Date.now(),
            eventType: ev.type,
            data: ev.data,
          };
          setMessages((prev) => [...prev, sysMsg]);
          scrollToBottom();
        },
        onDone: (result) => {
          const agentMsg: CIAgentMessage = {
            id: nextId(),
            role: "agent",
            content: JSON.stringify(result, null, 2),
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, agentMsg]);
          setStatus("complete");
          scrollToBottom();
        },
        onError: (err) => {
          const errMsg: CIAgentMessage = {
            id: nextId(),
            role: "system",
            content: `Error: ${err}`,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errMsg]);
          setStatus("error");
          scrollToBottom();
        },
      },
      { projectId }
    );
    wsRef.current = ws;
  }, [input, status, projectId]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto min-h-0 p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-xs text-gray-500 py-8">
            <Bot size={24} className="mx-auto mb-2 opacity-40" />
            Ask the Code Intelligence Agent to analyze, generate, or query your codebase.
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role !== "user" && (
              <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                msg.role === "agent" ? "bg-editor-accent/20" : "bg-editor-input"
              }`}>
                <Bot size={12} className={msg.role === "agent" ? "text-editor-accent" : "text-gray-500"} />
              </div>
            )}
            <div className={`max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed ${
              msg.role === "user"
                ? "bg-editor-accent text-white rounded-tr-sm"
                : msg.role === "agent"
                ? "bg-editor-active text-editor-fg rounded-tl-sm"
                : "bg-editor-input/50 text-gray-400 rounded-tl-sm text-[11px]"
            }`}>
              <pre className="whitespace-pre-wrap font-sans m-0">{msg.content}</pre>
            </div>
          </div>
        ))}
        {status === "running" && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={13} className="animate-spin" />
            Agent is working...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-editor-border p-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder="Ask the agent..."
            disabled={status === "running" || status === "connecting"}
            className="flex-1 px-3 py-2 text-xs bg-editor-input border border-editor-border rounded
                       text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-editor-accent
                       disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={status === "running" || status === "connecting" || !input.trim()}
            className="flex items-center justify-center w-8 h-8 rounded
                       bg-editor-accent text-white hover:bg-editor-accent/80
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
