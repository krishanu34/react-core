"use client";

import React, { useState, useMemo, useCallback } from "react";
import type { CBv2Artifact } from "@/types/code-builder-v2";
import { formatValue, formatFallbackContent } from "@/lib/format-content";
import {
  X,
  Search,
  Eye,
  CheckSquare,
  Square,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Copy,
  Check,
} from "lucide-react";

/* ── Artifact badge colors ────────────────────────────────────────────── */

const TYPE_COLORS: Record<string, string> = {
  epic: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  feature: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  user_story: "bg-green-500/20 text-green-300 border-green-500/30",
  story: "bg-green-500/20 text-green-300 border-green-500/30",
};

/* ── Content renderer ─────────────────────────────────────────────────── */

function StoryContent({ story }: { story: CBv2Artifact }) {
  const [copied, setCopied] = useState(false);
  const content = story.content ?? {};

  const sections: { label: string; value: string }[] = [];

  if (story.description) {
    sections.push({ label: "Description", value: story.description });
  }

  if (typeof content === "object" && content !== null) {
    const keyMap: Record<string, string> = {
      description: "Description",
      acceptance_criteria: "Acceptance Criteria",
      requirements: "Requirements",
      technical_notes: "Technical Notes",
      markdown: "Content",
      definition_of_done: "Definition of Done",
      assumptions: "Assumptions",
      dependencies: "Dependencies",
      priority: "Priority",
      story_points: "Story Points",
      notes: "Notes",
    };

    for (const [key, label] of Object.entries(keyMap)) {
      const val = (content as Record<string, unknown>)[key];
      if (!val) continue;
      const formatted = formatValue(val);
      if (formatted) {
        sections.push({ label, value: formatted });
      }
    }
  }

  // Fallback: show formatted content if no structured sections matched
  if (sections.length === 0 && content && Object.keys(content).length > 0) {
    sections.push({ label: "Content", value: formatFallbackContent(content as Record<string, unknown>) });
  }

  const fullText = sections.map((s) => `## ${s.label}\n${s.value}`).join("\n\n");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fullText]);

  return (
    <div className="space-y-3">
      {sections.length === 0 ? (
        <p className="text-[12px] text-cbv2-text-dim italic">No content available.</p>
      ) : (
        <>
          <div className="flex justify-end">
            <button
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors"
              onClick={handleCopy}
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied" : "Copy All"}
            </button>
          </div>
          {sections.map((section, idx) => (
            <div key={idx}>
              <h4 className="text-[11px] font-semibold text-cbv2-accent uppercase tracking-wide mb-1">
                {section.label}
              </h4>
              <div className="text-[12px] text-cbv2-text leading-relaxed whitespace-pre-wrap break-words bg-cbv2-input rounded px-3 py-2 border border-cbv2-border">
                {section.value}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ── Story Row in the list ────────────────────────────────────────────── */

function StoryRow({
  story,
  isSelected,
  isActive,
  onToggle,
  onView,
}: {
  story: CBv2Artifact;
  isSelected: boolean;
  isActive: boolean;
  onToggle: () => void;
  onView: () => void;
}) {
  return (
    <div
      className={[
        "flex items-center gap-3 px-4 py-2.5 border-b border-cbv2-border transition-colors cursor-pointer group",
        isActive
          ? "bg-cbv2-accent/10 border-l-2 border-l-cbv2-accent"
          : "hover:bg-cbv2-hover border-l-2 border-l-transparent",
      ].join(" ")}
      onClick={onView}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onClick={(e) => e.stopPropagation()}
        className="accent-cbv2-accent w-4 h-4 rounded cursor-pointer flex-shrink-0"
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-cbv2-text truncate">
            {story.title}
          </span>
          <span
            className={[
              "text-[9px] px-1.5 py-0.5 rounded border font-medium flex-shrink-0",
              TYPE_COLORS[story.artifact_type] ?? "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
            ].join(" ")}
          >
            {story.artifact_type.replace("_", " ")}
          </span>
        </div>
        {story.description && (
          <p className="text-[11px] text-cbv2-text-dim mt-0.5 line-clamp-1">
            {story.description}
          </p>
        )}
      </div>

      {/* ID badge */}
      <span className="text-[10px] text-cbv2-text-dim font-mono flex-shrink-0">
        #{story.id}
      </span>

      {/* View icon */}
      <Eye className="w-3.5 h-3.5 text-cbv2-text-dim opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </div>
  );
}

/* ── Main Modal ───────────────────────────────────────────────────────── */

interface StoryViewerModalProps {
  stories: CBv2Artifact[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onSelectAll: () => void;
  onClose: () => void;
}

export default function StoryViewerModal({
  stories,
  selectedIds,
  onToggle,
  onSelectAll,
  onClose,
}: StoryViewerModalProps) {
  const [search, setSearch] = useState("");
  const [activeStoryId, setActiveStoryId] = useState<number | null>(
    stories.length > 0 ? stories[0].id : null
  );
  const [isMaximized, setIsMaximized] = useState(true);

  // Filtered stories
  const filtered = useMemo(() => {
    if (!search.trim()) return stories;
    const q = search.toLowerCase();
    return stories.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artifact_type.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)
    );
  }, [stories, search]);

  // Group by type
  const grouped = useMemo(() => {
    const groups: Record<string, CBv2Artifact[]> = {};
    for (const s of filtered) {
      const t = s.artifact_type;
      if (!groups[t]) groups[t] = [];
      groups[t].push(s);
    }
    return groups;
  }, [filtered]);

  const activeStory = stories.find((s) => s.id === activeStoryId) ?? null;
  const allSelected = stories.length > 0 && selectedIds.length === stories.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className={[
          "bg-cbv2-bg border border-cbv2-border rounded-lg shadow-2xl flex flex-col overflow-hidden transition-all duration-200",
          isMaximized ? "w-[95vw] h-[90vh]" : "w-[80vw] h-[70vh] max-w-[1200px]",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cbv2-border bg-cbv2-sidebar shrink-0">
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-cbv2-accent" />
            <h2 className="text-[14px] font-semibold text-cbv2-text">
              User Stories
            </h2>
            <span className="px-2 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[11px] font-mono">
              {stories.length} total
            </span>
            {selectedIds.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 text-[11px] font-mono">
                {selectedIds.length} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
              onClick={() => setIsMaximized((m) => !m)}
              title={isMaximized ? "Restore size" : "Maximize"}
            >
              {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              className="p-1.5 rounded hover:bg-red-500/20 text-cbv2-text-dim hover:text-red-400 transition-colors"
              onClick={onClose}
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-cbv2-border bg-cbv2-sidebar shrink-0">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
            <input
              className="w-full pl-8 pr-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${stories.length} stories...`}
              autoFocus
            />
          </div>
          {/* Select all */}
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cbv2-border text-[11px] hover:border-cbv2-accent/30 transition-colors text-cbv2-text-dim hover:text-cbv2-accent"
            onClick={onSelectAll}
          >
            {allSelected ? (
              <CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            {allSelected ? "Deselect All" : "Select All"}
          </button>
        </div>

        {/* Body — split pane */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: story list */}
          <div className="w-[40%] border-r border-cbv2-border overflow-y-auto cbv2-scrollbar">
            {Object.entries(grouped).map(([type, arts]) => (
              <GroupSection key={type} type={type} stories={arts} activeId={activeStoryId} selectedIds={selectedIds} onToggle={onToggle} onView={setActiveStoryId} />
            ))}
            {filtered.length === 0 && (
              <div className="flex items-center justify-center py-8 text-[11px] text-cbv2-text-dim">
                No stories matching &quot;{search}&quot;
              </div>
            )}
          </div>

          {/* Right: story detail */}
          <div className="flex-1 overflow-y-auto cbv2-scrollbar p-4">
            {activeStory ? (
              <>
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[16px] font-semibold text-cbv2-text">
                      {activeStory.title}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={[
                          "text-[10px] px-2 py-0.5 rounded border font-medium",
                          TYPE_COLORS[activeStory.artifact_type] ?? "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
                        ].join(" ")}
                      >
                        {activeStory.artifact_type.replace("_", " ")}
                      </span>
                      <span className="text-[11px] text-cbv2-text-dim font-mono">
                        #{activeStory.id}
                      </span>
                      {activeStory.version && (
                        <span className="text-[10px] text-cbv2-text-dim">
                          v{activeStory.version}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className={[
                      "flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium transition-colors",
                      selectedIds.includes(activeStory.id)
                        ? "bg-cbv2-accent text-white"
                        : "bg-cbv2-input text-cbv2-text border border-cbv2-border hover:border-cbv2-accent/40",
                    ].join(" ")}
                    onClick={() => onToggle(activeStory.id)}
                  >
                    {selectedIds.includes(activeStory.id) ? (
                      <CheckSquare className="w-3.5 h-3.5" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                    {selectedIds.includes(activeStory.id) ? "Selected" : "Select"}
                  </button>
                </div>
                <StoryContent story={activeStory} />
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-cbv2-text-dim text-[12px]">
                Select a story from the list to view details
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-cbv2-border bg-cbv2-sidebar flex items-center justify-between shrink-0">
          <span className="text-[11px] text-cbv2-text-dim">
            {selectedIds.length} of {stories.length} stories selected — selected stories will be included with your prompt
          </span>
          <button
            className="px-4 py-1.5 rounded bg-cbv2-accent text-white text-[12px] font-medium hover:bg-cbv2-accent/80 transition-colors"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Grouped section (epic / feature / story) ─────────────────────────── */

function GroupSection({
  type,
  stories,
  activeId,
  selectedIds,
  onToggle,
  onView,
}: {
  type: string;
  stories: CBv2Artifact[];
  activeId: number | null;
  selectedIds: number[];
  onToggle: (id: number) => void;
  onView: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const selectedCount = stories.filter((s) => selectedIds.includes(s.id)).length;

  return (
    <div>
      <button
        className="w-full flex items-center gap-2 px-4 py-2 text-[11px] font-semibold text-cbv2-text-dim hover:bg-cbv2-hover transition-colors uppercase tracking-wide bg-cbv2-sidebar border-b border-cbv2-border"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="flex-1 text-left">{type.replace("_", " ")}s</span>
        <span className="text-[10px] font-mono text-cbv2-text-dim">
          {selectedCount > 0 && <span className="text-cbv2-accent mr-1">{selectedCount}/</span>}
          {stories.length}
        </span>
      </button>
      {open && stories.map((story) => (
        <StoryRow
          key={story.id}
          story={story}
          isSelected={selectedIds.includes(story.id)}
          isActive={activeId === story.id}
          onToggle={() => onToggle(story.id)}
          onView={() => onView(story.id)}
        />
      ))}
    </div>
  );
}
