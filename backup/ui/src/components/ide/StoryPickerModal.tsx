"use client";

import { useMemo, useState } from "react";
import {
  X, Search, CheckCircle2, Clock, ChevronRight,
  CheckSquare, Square, Maximize2, Minimize2, BookOpen,
} from "lucide-react";
import type { CBv2ArtifactItem } from "@/hooks/useCodeBuilderQueries";

/* ── Helpers ─────────────────────────────────────────────────────────── */

function ApprovalBadge({ approved }: { approved: boolean }) {
  return approved
    ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
    : <Clock className="h-3 w-3 text-amber-400 shrink-0" />;
}

const TYPE_LABEL: Record<string, string> = {
  epic: "Epic", feature: "Feature", user_story: "User Story", story: "Story",
};

interface Group { type: string; label: string; items: CBv2ArtifactItem[]; }

function groupArtifacts(items: CBv2ArtifactItem[]): Group[] {
  const map = new Map<string, CBv2ArtifactItem[]>();
  for (const item of items) {
    const key = item.artifact_type;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  const order = ["epic", "feature", "user_story", "story"];
  return [...map.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    .map(([type, items]) => ({ type, label: TYPE_LABEL[type] ?? type, items }));
}

/* ── Detail pane ─────────────────────────────────────────────────────── */

function StoryDetail({ story }: { story: CBv2ArtifactItem }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (story as any).content as Record<string, unknown> | undefined;

  return (
    <div className="p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <ApprovalBadge approved={story.is_approved} />
          <span className="text-[10px] font-mono text-[var(--ide-muted)]">
            {story.content_id ?? story.artifact_type.toUpperCase()}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-[var(--ide-text)]">{story.title ?? "Untitled"}</h3>
      </div>

      {story.description && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-1 font-semibold">Description</p>
          <p className="text-xs text-[var(--ide-text)] leading-relaxed whitespace-pre-wrap">{story.description}</p>
        </div>
      )}

      {content && Object.entries(content).map(([key, value]) => {
        if (!value || key === "title" || key === "description") return null;
        const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const text = Array.isArray(value)
          ? value.map((v, i) => `${i + 1}. ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
          : typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return (
          <div key={key}>
            <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-1 font-semibold">{label}</p>
            <p className="text-xs text-[var(--ide-text)] leading-relaxed whitespace-pre-wrap">{text}</p>
          </div>
        );
      })}

      {!story.description && !content && (
        <p className="text-xs text-[var(--ide-muted)] italic">No content available</p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  StoryPickerModal
 * ══════════════════════════════════════════════════════════════════════ */
export function StoryPickerModal({
  stories,
  selectedIds,
  onDone,
  onClose,
}: {
  stories: CBv2ArtifactItem[];
  selectedIds: Set<number>;
  onDone: (ids: Set<number>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(selectedIds));
  const [activeId, setActiveId] = useState<number | null>(stories[0]?.id ?? null);
  const [maximized, setMaximized] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!search.trim()) return stories;
    const q = search.toLowerCase();
    return stories.filter((s) =>
      (s.title ?? "").toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q) ||
      (s.content_id ?? "").toLowerCase().includes(q)
    );
  }, [stories, search]);

  const groups = useMemo(() => groupArtifacts(filtered), [filtered]);
  const activeStory = stories.find((s) => s.id === activeId) ?? null;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(filtered.map((s) => s.id)));
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
          <BookOpen className="h-4 w-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-[var(--ide-text)] flex-1">Select User Stories</h2>
          <span className="text-xs text-[var(--ide-muted)]">{selected.size} / {stories.length} selected</span>
          <button type="button" onClick={() => setMaximized((v) => !v)} title={maximized ? "Restore" : "Maximize"}
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
              placeholder="Search stories…"
              className="flex-1 bg-transparent text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] outline-none" />
          </div>
          <button type="button" onClick={selectAll}
            className="text-xs text-violet-400 hover:text-violet-300 shrink-0">Select All</button>
          <button type="button" onClick={clearAll}
            className="text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] shrink-0">Clear</button>
        </div>

        {/* Split pane */}
        <div className="flex flex-1 min-h-0">

          {/* Left: grouped list */}
          <div className="w-[40%] border-r border-[var(--ide-border)] overflow-y-auto">
            {groups.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-[var(--ide-muted)]">No stories found</p>
            ) : (
              groups.map((g) => (
                <div key={g.type}>
                  <button type="button" onClick={() => toggleGroup(g.type)}
                    className="flex items-center gap-2 w-full px-4 py-2 text-left bg-[var(--ide-surface-2)]/50 border-b border-[var(--ide-border)] hover:bg-[var(--ide-surface-2)] transition-colors">
                    <ChevronRight className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${!collapsed.has(g.type) ? "rotate-90" : ""}`} />
                    <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] font-semibold flex-1">{g.label}</span>
                    <span className="text-[10px] text-[var(--ide-muted)]">
                      {g.items.filter((i) => selected.has(i.id)).length}/{g.items.length}
                    </span>
                  </button>
                  {!collapsed.has(g.type) && g.items.map((item) => (
                    <div key={item.id}
                      className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-colors ${
                        activeId === item.id ? "bg-violet-600/15" : "hover:bg-[var(--ide-surface-2)]/60"
                      }`}>
                      <button type="button" onClick={() => toggle(item.id)} className="shrink-0">
                        {selected.has(item.id)
                          ? <CheckSquare className="h-4 w-4 text-violet-400" />
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
              ))
            )}
          </div>

          {/* Right: detail */}
          <div className="w-[60%] overflow-y-auto bg-[var(--ide-surface)]">
            {activeStory ? (
              <StoryDetail story={activeStory} />
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-[var(--ide-muted)]">
                Select a story to view details
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

export default StoryPickerModal;
