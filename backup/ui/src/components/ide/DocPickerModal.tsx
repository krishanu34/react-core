"use client";

import { useMemo, useState } from "react";
import {
  X, Search, CheckCircle2, Clock, ChevronRight,
  CheckSquare, Square, Maximize2, Minimize2, FileText,
} from "lucide-react";
import type { CBv2ArtifactItem } from "@/hooks/useCodeBuilderQueries";

/* ── Helpers ─────────────────────────────────────────────────────────── */

function ApprovalBadge({ approved }: { approved: boolean }) {
  return approved
    ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
    : <Clock className="h-3 w-3 text-amber-400 shrink-0" />;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  hld_document: "High-Level Design", lld_document: "Low-Level Design",
  req_document: "Requirements", requirements_document: "Requirements",
  srs_document: "SRS", ddd_document: "Domain Design",
  api_spec_document: "API Specification", test_plan_document: "Test Plan",
};

const DOC_TYPE_SHORT: Record<string, string> = {
  hld_document: "HLD", lld_document: "LLD", req_document: "REQ",
  requirements_document: "REQ", srs_document: "SRS", ddd_document: "DDD",
  api_spec_document: "API", test_plan_document: "TEST",
};

const DOC_TYPE_COLOR: Record<string, string> = {
  hld_document: "text-blue-300 bg-blue-900/40",
  lld_document: "text-purple-300 bg-purple-900/40",
  req_document: "text-green-300 bg-green-900/40",
  requirements_document: "text-green-300 bg-green-900/40",
  srs_document: "text-emerald-300 bg-emerald-900/40",
  ddd_document: "text-orange-300 bg-orange-900/40",
  api_spec_document: "text-cyan-300 bg-cyan-900/40",
  test_plan_document: "text-pink-300 bg-pink-900/40",
};

interface Group { type: string; label: string; items: CBv2ArtifactItem[]; }

function groupDocuments(items: CBv2ArtifactItem[]): Group[] {
  const map = new Map<string, CBv2ArtifactItem[]>();
  for (const item of items) {
    if (!map.has(item.artifact_type)) map.set(item.artifact_type, []);
    map.get(item.artifact_type)!.push(item);
  }
  return [...map.entries()].map(([type, items]) => ({
    type,
    label: DOC_TYPE_LABEL[type] ?? type.replace(/_document$/, "").replace(/_/g, " ").toUpperCase(),
    items,
  }));
}

/* ── Detail pane ─────────────────────────────────────────────────────── */

function DocDetail({ doc }: { doc: CBv2ArtifactItem }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (doc as any).content as Record<string, unknown> | undefined;
  const shortType = DOC_TYPE_SHORT[doc.artifact_type] ?? doc.artifact_type.toUpperCase();
  const colorCls = DOC_TYPE_COLOR[doc.artifact_type] ?? "text-[var(--ide-text)] bg-[var(--ide-surface-2)]";

  return (
    <div className="p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <ApprovalBadge approved={doc.is_approved} />
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${colorCls}`}>
            {shortType}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-[var(--ide-text)]">{doc.title ?? "Untitled"}</h3>
      </div>

      {doc.description && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-1 font-semibold">Description</p>
          <p className="text-xs text-[var(--ide-text)] leading-relaxed whitespace-pre-wrap">{doc.description}</p>
        </div>
      )}

      {content && Object.entries(content).map(([key, value]) => {
        if (!value || key === "title" || key === "description") return null;
        const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const text = Array.isArray(value)
          ? value.map((v, i) => typeof v === "object" && v !== null && "content" in v
              ? `### ${(v as { title?: string }).title ?? `Section ${i + 1}`}\n${(v as { content?: string }).content ?? ""}`
              : `${i + 1}. ${typeof v === "string" ? v : JSON.stringify(v)}`
            ).join("\n\n")
          : typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return (
          <div key={key}>
            <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-1 font-semibold">{label}</p>
            <p className="text-xs text-[var(--ide-text)] leading-relaxed whitespace-pre-wrap">{text}</p>
          </div>
        );
      })}

      {!doc.description && !content && (
        <p className="text-xs text-[var(--ide-muted)] italic">No content available</p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  DocPickerModal
 * ══════════════════════════════════════════════════════════════════════ */
export function DocPickerModal({
  documents,
  selectedIds,
  onDone,
  onClose,
}: {
  documents: CBv2ArtifactItem[];
  selectedIds: Set<number>;
  onDone: (ids: Set<number>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(selectedIds));
  const [activeId, setActiveId] = useState<number | null>(documents[0]?.id ?? null);
  const [maximized, setMaximized] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!search.trim()) return documents;
    const q = search.toLowerCase();
    return documents.filter((d) =>
      (d.title ?? "").toLowerCase().includes(q) ||
      (d.description ?? "").toLowerCase().includes(q) ||
      d.artifact_type.toLowerCase().includes(q)
    );
  }, [documents, search]);

  const groups = useMemo(() => groupDocuments(filtered), [filtered]);
  const activeDoc = documents.find((d) => d.id === activeId) ?? null;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(filtered.map((d) => d.id)));
  const clearAll = () => setSelected(new Set());

  const toggleGroup = (type: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={`flex flex-col rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl overflow-hidden ${
        maximized ? "w-[90vw] h-[85vh]" : "w-full max-w-4xl mx-4 h-[70vh]"
      }`}>

        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--ide-border)] shrink-0">
          <FileText className="h-4 w-4 text-teal-400" />
          <h2 className="text-sm font-semibold text-[var(--ide-text)] flex-1">Select Documents</h2>
          <span className="text-xs text-[var(--ide-muted)]">{selected.size} / {documents.length} selected</span>
          <button type="button" onClick={() => setMaximized((v) => !v)}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)] transition-colors">
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--ide-border)] shrink-0">
          <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)]">
            <Search className="h-3.5 w-3.5 text-[var(--ide-muted)]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search documents…"
              className="flex-1 bg-transparent text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] outline-none" />
          </div>
          <button type="button" onClick={selectAll}
            className="text-xs text-teal-400 hover:text-teal-300 shrink-0">Select All</button>
          <button type="button" onClick={clearAll}
            className="text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] shrink-0">Clear</button>
        </div>

        {/* Split pane */}
        <div className="flex flex-1 min-h-0">

          {/* Left: grouped list */}
          <div className="w-[40%] border-r border-[var(--ide-border)] overflow-y-auto">
            {groups.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-[var(--ide-muted)]">No documents found</p>
            ) : (
              groups.map((g) => {
                const colorCls = DOC_TYPE_COLOR[g.type] ?? "text-[var(--ide-text)] bg-[var(--ide-surface-2)]";
                return (
                  <div key={g.type}>
                    <button type="button" onClick={() => toggleGroup(g.type)}
                      className="flex items-center gap-2 w-full px-4 py-2 text-left bg-[var(--ide-surface-2)]/50 border-b border-[var(--ide-border)] hover:bg-[var(--ide-surface-2)] transition-colors">
                      <ChevronRight className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${!collapsed.has(g.type) ? "rotate-90" : ""}`} />
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold shrink-0 ${colorCls}`}>
                        {DOC_TYPE_SHORT[g.type] ?? g.type.slice(0, 3).toUpperCase()}
                      </span>
                      <span className="text-[10px] text-[var(--ide-muted)] font-medium flex-1">{g.label}</span>
                      <span className="text-[10px] text-[var(--ide-muted)]">
                        {g.items.filter((i) => selected.has(i.id)).length}/{g.items.length}
                      </span>
                    </button>
                    {!collapsed.has(g.type) && g.items.map((item) => (
                      <div key={item.id}
                        className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-colors ${
                          activeId === item.id ? "bg-teal-600/15" : "hover:bg-[var(--ide-surface-2)]/60"
                        }`}>
                        <button type="button" onClick={() => toggle(item.id)} className="shrink-0">
                          {selected.has(item.id)
                            ? <CheckSquare className="h-4 w-4 text-teal-400" />
                            : <Square className="h-4 w-4 text-[var(--ide-muted)]" />}
                        </button>
                        <button type="button" onClick={() => setActiveId(item.id)}
                          className="flex items-center gap-2 flex-1 min-w-0 text-left">
                          <ApprovalBadge approved={item.is_approved} />
                          <span className="text-xs text-[var(--ide-text)] truncate">{item.title ?? "Untitled"}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>

          {/* Right: detail */}
          <div className="w-[60%] overflow-y-auto bg-[var(--ide-surface)]">
            {activeDoc ? (
              <DocDetail doc={activeDoc} />
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-[var(--ide-muted)]">
                Select a document to view details
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--ide-border)] shrink-0">
          <span className="text-xs text-[var(--ide-muted)]">{selected.size} selected</span>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose}
              className="h-8 px-3 rounded-md border border-[var(--ide-border)] text-sm text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] transition-colors">
              Cancel
            </button>
            <button type="button" onClick={() => { onDone(selected); onClose(); }}
              className="inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DocPickerModal;
