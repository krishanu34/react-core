"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useCBv2ApprovedArtifacts } from "@/hooks/useCodeBuilderQueries";
import type { CBv2Artifact } from "@/types/code-builder-v2";
import { formatValue, formatFallbackContent } from "@/lib/format-content";
import {
  ArtifactFilterChips,
  RunFlagBadges,
  applyArtifactFilter,
  getArtifactFilterCounts,
  type ArtifactFilter,
} from "./ArtifactFilterChips";
import { Star, Flag } from "lucide-react";
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
  AlertTriangle,
  Layers,
} from "lucide-react";

/* ── Types ────────────────────────────────────────────────────────────── */

interface FeatureGroup {
  feature_id: string;
  feature_name: string;
  /** The feature artifact itself, if one exists (null for synthetic buckets). */
  feature?: CBv2Artifact | null;
  stories: CBv2Artifact[];
}

interface EpicNode {
  epic_id: string;
  epic_name: string;
  /** The epic artifact itself, if one exists (null for the synthetic
   *  "Standalone Features" / "Standalone Stories" buckets). */
  epic?: CBv2Artifact | null;
  features: FeatureGroup[];
  /** Stories that have no feature parent — shown directly under the epic. */
  orphanStories: CBv2Artifact[];
}

interface DependencyInfo {
  missingStories: CBv2Artifact[];
  allDependencies: string[];
}

/* ── Tri-state checkbox (checked / unchecked / indeterminate) ────────── */

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
  className,
  title,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        e.stopPropagation();
        onChange();
      }}
      onClick={(e) => e.stopPropagation()}
      className={className}
      title={title}
    />
  );
}

/* ── Badge colours ────────────────────────────────────────────────────── */

const TYPE_COLORS: Record<string, string> = {
  epic: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  feature: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  user_story: "bg-green-500/20 text-green-300 border-green-500/30",
  story: "bg-green-500/20 text-green-300 border-green-500/30",
};

/* ── Dependency Dialog ────────────────────────────────────────────────── */

function DependencyDialog({
  dependencies,
  onInclude,
  onExclude,
  onClose,
}: {
  dependencies: CBv2Artifact[];
  onInclude: () => void;
  onExclude: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-cbv2-sidebar border border-yellow-500/30 rounded-lg shadow-2xl w-[600px] max-h-[70vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-cbv2-border bg-yellow-500/10">
          <AlertTriangle className="w-5 h-5 text-yellow-400" />
          <h3 className="text-[14px] font-semibold text-cbv2-text flex-1">
            Dependency Validation
          </h3>
          <button
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-[12px] text-cbv2-text leading-relaxed">
            The selected user stories have dependencies (<strong>blocked_by</strong>) on the
            following stories that are <em>not</em> selected. Including them ensures your
            generated code covers all pre-requisites.
          </p>

          <div className="space-y-2 bg-cbv2-bg rounded-lg p-3 border border-cbv2-border">
            {dependencies.map((dep) => (
              <div
                key={dep.id}
                className="flex items-start gap-3 p-2 rounded bg-cbv2-input border border-cbv2-border"
              >
                <BookOpen className="w-4 h-4 text-cbv2-accent mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-cbv2-text">
                    {dep.title}
                  </div>
                  {dep.description && (
                    <p className="text-[11px] text-cbv2-text-dim mt-1 line-clamp-2">
                      {dep.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={[
                        "text-[9px] px-1.5 py-0.5 rounded border font-medium",
                        TYPE_COLORS[dep.artifact_type] ??
                          "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
                      ].join(" ")}
                    >
                      {dep.artifact_type.replace("_", " ")}
                    </span>
                    <span className="text-[10px] text-cbv2-text-dim font-mono">
                      #{dep.id}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-cbv2-border bg-cbv2-sidebar">
          <button
            className="px-4 py-1.5 rounded text-[12px] font-medium text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors"
            onClick={onExclude}
          >
            No, Continue Without
          </button>
          <button
            className="px-4 py-1.5 rounded bg-cbv2-accent text-white text-[12px] font-medium hover:bg-cbv2-accent/80 transition-colors flex items-center gap-1.5"
            onClick={onInclude}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            Yes, Include Dependencies
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Story content renderer ───────────────────────────────────────────── */

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
      business_rules: "Business Rules",
      technical_changes: "Technical Changes",
      implementation_notes: "Implementation Notes",
      story_points: "Story Points",
      relationships: "Relationships",
    };

    for (const [key, label] of Object.entries(keyMap)) {
      const val = (content as Record<string, unknown>)[key];
      if (!val) continue;
      if (key === "description" && val === story.description) continue; // already shown

      const formatted = formatValue(val);
      if (formatted) {
        sections.push({ label, value: formatted });
      }
    }
  }

  if (sections.length === 0 && content && Object.keys(content).length > 0) {
    sections.push({
      label: "Content",
      value: formatFallbackContent(content as Record<string, unknown>),
    });
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

/* ── Story card (mirrors Job Dashboard StoryCard styling) ──────────────── */

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
  const content = (story.content as Record<string, unknown> | undefined) ?? {};
  const storyIdLabel =
    (content.story_id as string) || story.artifact_id || `#${story.id}`;

  return (
    <div
      className={[
        "rounded-lg border bg-slate-900/40 transition-colors cursor-pointer group",
        isActive
          ? "border-emerald-500/60 ring-1 ring-emerald-500/30"
          : "border-slate-700/70 hover:border-slate-600 hover:bg-slate-800/40",
      ].join(" ")}
      onClick={onView}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => { e.stopPropagation(); onToggle(); }}
          onClick={(e) => e.stopPropagation()}
          className="accent-emerald-500 w-3.5 h-3.5 rounded cursor-pointer flex-shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-emerald-300 uppercase tracking-wide">
              Story
            </span>
            <span className="text-[10px] font-mono text-slate-500 truncate max-w-[120px]">
              {storyIdLabel}
            </span>
            <RunFlagBadges
              starred={story.run_is_selected}
              flagged={story.run_review_flag}
              approved={story.approval_status === "approved"}
              size="xs"
            />
            {story.version != null && story.version > 1 && (
              <span className="text-[9px] font-mono text-sky-400">v{story.version}</span>
            )}
          </div>
          <div className="mt-1 text-[12px] font-medium text-slate-100 leading-snug line-clamp-2">
            {story.title}
          </div>
          {story.description && (
            <p className="mt-0.5 text-[11px] text-slate-400 line-clamp-1">
              {story.description}
            </p>
          )}
        </div>
        <Eye className="w-3.5 h-3.5 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
      </div>
    </div>
  );
}

/* ── Feature section (mirrors Job Dashboard FeatureSection) ───────────── */

function FeatureSection({
  feature,
  activeId,
  selectedIds,
  onToggle,
  onView,
}: {
  feature: FeatureGroup;
  activeId: number | null;
  selectedIds: number[];
  onToggle: (id: number) => void;
  onView: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const descendants: CBv2Artifact[] = [
    ...(feature.feature ? [feature.feature] : []),
    ...feature.stories,
  ];
  const selectedCount = descendants.filter((s) => selectedIds.includes(s.id)).length;
  const starredCount = descendants.filter((s) => s.run_is_selected).length;
  const flaggedCount = descendants.filter((s) => s.run_review_flag).length;
  const featureIdLabel = feature.feature?.artifact_id || feature.feature_id;
  const isFeatureActive =
    feature.feature != null && feature.feature.id === activeId;

  return (
    <div className="rounded-xl border border-indigo-900/50 bg-indigo-950/10">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((v) => !v);
        }}
        className={[
          "flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-colors rounded-t-xl",
          isFeatureActive ? "bg-indigo-900/20" : "hover:bg-indigo-900/10",
        ].join(" ")}
      >
        <span className="mt-0.5 text-indigo-400 shrink-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
        <Layers className="h-3.5 w-3.5 text-indigo-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-900/60 text-indigo-300 uppercase tracking-wide">
              Feature
            </span>
            <span className="text-[12px] font-semibold text-slate-100 truncate">
              {feature.feature_name}
            </span>
            <span className="text-[10px] font-mono text-slate-500 truncate max-w-[120px]">
              {featureIdLabel}
            </span>
            <RunFlagBadges
              starred={feature.feature?.run_is_selected}
              flagged={feature.feature?.run_review_flag}
              approved={feature.feature?.approval_status === "approved"}
              size="xs"
            />
            {(starredCount > 0 || flaggedCount > 0) && (
              <span className="flex items-center gap-1">
                {starredCount > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-yellow-300 font-mono"
                    title={`${starredCount} starred (rollup)`}
                  >
                    <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                    {starredCount}
                  </span>
                )}
                {flaggedCount > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-orange-300 font-mono"
                    title={`${flaggedCount} flagged (rollup)`}
                  >
                    <Flag className="w-3 h-3 fill-orange-400 text-orange-400" />
                    {flaggedCount}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {feature.feature && (
            <IndeterminateCheckbox
              checked={
                descendants.length > 0 &&
                descendants.every((d) => selectedIds.includes(d.id))
              }
              indeterminate={selectedCount > 0}
              onChange={() => onToggle(feature.feature!.id)}
              className="accent-indigo-400 w-3.5 h-3.5 rounded cursor-pointer"
              title="Select feature and all its stories"
            />
          )}
          {feature.feature && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onView(feature.feature!.id);
              }}
              className="p-0.5 rounded hover:bg-indigo-900/30 text-slate-400 hover:text-indigo-300"
              title="View feature detail"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {selectedCount > 0 && (
              <span className="text-emerald-400 mr-1">{selectedCount}/</span>
            )}
            {feature.stories.length}{" "}
            {feature.stories.length === 1 ? "story" : "stories"}
          </span>
        </div>
      </div>

      {open && feature.stories.length > 0 && (
        <div className="px-3 pb-3 pt-1 space-y-1.5">
          {feature.stories.map((story) => (
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
      )}
    </div>
  );
}

/* ── Epic section (mirrors Job Dashboard EpicSection) ──────────────────── */

function EpicSection({
  epic,
  activeId,
  selectedIds,
  onToggle,
  onView,
}: {
  epic: EpicNode;
  activeId: number | null;
  selectedIds: number[];
  onToggle: (id: number) => void;
  onView: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const descendants: CBv2Artifact[] = [
    ...(epic.epic ? [epic.epic] : []),
    ...epic.features.flatMap((f) => [
      ...(f.feature ? [f.feature] : []),
      ...f.stories,
    ]),
    ...epic.orphanStories,
  ];
  const selectedCount = descendants.filter((a) => selectedIds.includes(a.id)).length;
  const starredCount = descendants.filter((a) => a.run_is_selected).length;
  const flaggedCount = descendants.filter((a) => a.run_review_flag).length;
  const totalStories =
    epic.features.reduce((n, f) => n + f.stories.length, 0) +
    epic.orphanStories.length;
  const epicIdLabel = epic.epic?.artifact_id || epic.epic_id;
  const isEpicActive = epic.epic != null && epic.epic.id === activeId;

  return (
    <div className="rounded-xl border border-violet-800/50 bg-violet-950/10">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((v) => !v);
        }}
        className={[
          "flex items-start gap-2 px-3 py-3 cursor-pointer transition-colors rounded-t-xl",
          isEpicActive ? "bg-violet-900/20" : "hover:bg-violet-900/10",
        ].join(" ")}
      >
        <span className="mt-0.5 text-violet-500 shrink-0">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
        <BookOpen className="h-4 w-4 text-violet-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-900/60 text-violet-300 uppercase tracking-wide">
              Epic
            </span>
            <span className="text-[13px] font-bold text-slate-100 truncate">
              {epic.epic_name}
            </span>
            <span className="text-[10px] font-mono text-slate-500 truncate max-w-[140px]">
              {epicIdLabel}
            </span>
            <RunFlagBadges
              starred={epic.epic?.run_is_selected}
              flagged={epic.epic?.run_review_flag}
              approved={epic.epic?.approval_status === "approved"}
              size="xs"
            />
            {(starredCount > 0 || flaggedCount > 0) && (
              <span className="flex items-center gap-1">
                {starredCount > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-yellow-300 font-mono"
                    title={`${starredCount} starred (rollup)`}
                  >
                    <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                    {starredCount}
                  </span>
                )}
                {flaggedCount > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-orange-300 font-mono"
                    title={`${flaggedCount} flagged (rollup)`}
                  >
                    <Flag className="w-3 h-3 fill-orange-400 text-orange-400" />
                    {flaggedCount}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {epic.epic && (
            <IndeterminateCheckbox
              checked={
                descendants.length > 0 &&
                descendants.every((d) => selectedIds.includes(d.id))
              }
              indeterminate={selectedCount > 0}
              onChange={() => onToggle(epic.epic!.id)}
              className="accent-violet-400 w-3.5 h-3.5 rounded cursor-pointer"
              title="Select epic and everything under it"
            />
          )}
          {epic.epic && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onView(epic.epic!.id);
              }}
              className="p-0.5 rounded hover:bg-violet-900/30 text-slate-400 hover:text-violet-300"
              title="View epic detail"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {epic.features.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
              {epic.features.length} feat
            </span>
          )}
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {selectedCount > 0 && (
              <span className="text-emerald-400 mr-1">{selectedCount}/</span>
            )}
            {totalStories}{" "}
            {totalStories === 1 ? "story" : "stories"}
          </span>
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {/* Epic → Feature → Story */}
          {epic.features.map((feat) => (
            <FeatureSection
              key={feat.feature_id}
              feature={feat}
              activeId={activeId}
              selectedIds={selectedIds}
              onToggle={onToggle}
              onView={onView}
            />
          ))}
          {/* Epic → Story (no feature in between) */}
          {epic.orphanStories.length > 0 && (
            <div className="space-y-1.5">
              {epic.features.length > 0 && (
                <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold pt-1">
                  Stories (no feature)
                </div>
              )}
              {epic.orphanStories.map((story) => (
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
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main Modal ───────────────────────────────────────────────────────── */

interface UserStoryViewerModalProps {
  projectId: number;
  initialSelectedIds?: number[];
  onClose: () => void;
  onStoriesSelected: (storyIds: number[], stories: CBv2Artifact[]) => void;
}

export default function UserStoryViewerModal({
  projectId,
  initialSelectedIds = [],
  onClose,
  onStoriesSelected,
}: UserStoryViewerModalProps) {
  const { data: rawArtifacts = [], isLoading: loading } = useCBv2ApprovedArtifacts(projectId);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArtifactFilter>("starred");
  const [selectedIds, setSelectedIds] = useState<number[]>(initialSelectedIds);
  const [activeStoryId, setActiveStoryId] = useState<number | null>(null);
  const [isMaximized, setIsMaximized] = useState(true);
  const [showDependencyDialog, setShowDependencyDialog] = useState(false);
  const [dependencyInfo, setDependencyInfo] = useState<DependencyInfo | null>(null);
  const [pendingSelection, setPendingSelection] = useState<number[] | null>(null);

  // ── Derive features and allStories from query data ─────────────────
  const allStories = rawArtifacts as CBv2Artifact[];

  // Build the true Epic → Feature → Story tree. We try multiple linkage
  // hints because the backend records the parent in any of:
  //   1. parent_artifact_id (DB id of the parent artifact row)
  //   2. content.epic_id / content.feature_id (string artifact_id UUID)
  //   3. content.parent_id (legacy)
  const epics = useMemo<EpicNode[]>(() => {
    const arts = allStories;
    if (arts.length === 0) return [];

    const epicArts = arts.filter((a) => a.artifact_type === "epic");
    const featureArts = arts.filter((a) => a.artifact_type === "feature");
    const storyArts = arts.filter(
      (a) => a.artifact_type === "user_story" || a.artifact_type === "story",
    );

    // Lookups so we can resolve parents from either the numeric DB id or
    // the string artifact_id surfaced in content references.
    const epicById = new Map<number, CBv2Artifact>();
    const epicByArtifactId = new Map<string, CBv2Artifact>();
    for (const e of epicArts) {
      epicById.set(e.id, e);
      if (e.artifact_id) epicByArtifactId.set(e.artifact_id, e);
    }

    const featureById = new Map<number, CBv2Artifact>();
    const featureByArtifactId = new Map<string, CBv2Artifact>();
    for (const f of featureArts) {
      featureById.set(f.id, f);
      if (f.artifact_id) featureByArtifactId.set(f.artifact_id, f);
    }

    const resolveEpicForFeature = (f: CBv2Artifact): CBv2Artifact | null => {
      if (f.parent_artifact_id != null && epicById.has(f.parent_artifact_id)) {
        return epicById.get(f.parent_artifact_id) ?? null;
      }
      const c = (f.content as Record<string, unknown> | undefined) ?? {};
      const epicRef = (c.epic_id as string) || (c.parent_id as string) || "";
      if (epicRef && epicByArtifactId.has(epicRef)) {
        return epicByArtifactId.get(epicRef) ?? null;
      }
      return null;
    };

    const resolveFeatureForStory = (s: CBv2Artifact): CBv2Artifact | null => {
      if (s.parent_artifact_id != null && featureById.has(s.parent_artifact_id)) {
        return featureById.get(s.parent_artifact_id) ?? null;
      }
      const c = (s.content as Record<string, unknown> | undefined) ?? {};
      const featureRef = (c.feature_id as string) || (c.parent_id as string) || "";
      if (featureRef && featureByArtifactId.has(featureRef)) {
        return featureByArtifactId.get(featureRef) ?? null;
      }
      return null;
    };

    // Build feature groups keyed by feature artifact id (string).
    const featureGroupByArtifactId = new Map<string, FeatureGroup>();
    for (const f of featureArts) {
      const key = f.artifact_id || `__feature_${f.id}`;
      featureGroupByArtifactId.set(key, {
        feature_id: key,
        feature_name: f.title || "Untitled feature",
        feature: f,
        stories: [],
      });
    }

    // Attach stories to their feature, collecting orphans for later.
    const orphanStoriesByEpic = new Map<string, CBv2Artifact[]>();
    const standaloneStories: CBv2Artifact[] = [];
    for (const s of storyArts) {
      const feat = resolveFeatureForStory(s);
      if (feat) {
        const key = feat.artifact_id || `__feature_${feat.id}`;
        featureGroupByArtifactId.get(key)?.stories.push(s);
        continue;
      }
      // Story has no feature — does it at least know its epic?
      const c = (s.content as Record<string, unknown> | undefined) ?? {};
      const epicRef = (c.epic_id as string) || "";
      if (epicRef && epicByArtifactId.has(epicRef)) {
        if (!orphanStoriesByEpic.has(epicRef)) orphanStoriesByEpic.set(epicRef, []);
        orphanStoriesByEpic.get(epicRef)!.push(s);
      } else {
        standaloneStories.push(s);
      }
    }

    // Assemble epic nodes.
    const epicNodes = new Map<string, EpicNode>();
    for (const e of epicArts) {
      const key = e.artifact_id || `__epic_${e.id}`;
      epicNodes.set(key, {
        epic_id: key,
        epic_name: e.title || "Untitled epic",
        epic: e,
        features: [],
        orphanStories: orphanStoriesByEpic.get(e.artifact_id || "") ?? [],
      });
    }

    const standaloneFeatures: FeatureGroup[] = [];
    for (const f of featureArts) {
      const key = f.artifact_id || `__feature_${f.id}`;
      const group = featureGroupByArtifactId.get(key)!;
      const parentEpic = resolveEpicForFeature(f);
      if (parentEpic) {
        const epicKey = parentEpic.artifact_id || `__epic_${parentEpic.id}`;
        epicNodes.get(epicKey)?.features.push(group);
      } else {
        standaloneFeatures.push(group);
      }
    }

    const result: EpicNode[] = Array.from(epicNodes.values());

    if (standaloneFeatures.length > 0) {
      result.push({
        epic_id: "__standalone_features__",
        epic_name: "Standalone Features",
        epic: null,
        features: standaloneFeatures,
        orphanStories: [],
      });
    }

    if (standaloneStories.length > 0) {
      result.push({
        epic_id: "__standalone_stories__",
        epic_name: "Standalone Stories",
        epic: null,
        features: [],
        orphanStories: standaloneStories,
      });
    }

    return result;
  }, [allStories]);

  // ── Set initial active story when data loads ───────────────────────
  useEffect(() => {
    if (allStories.length > 0 && activeStoryId === null) {
      setActiveStoryId(allStories[0].id);
    }
  }, [allStories, activeStoryId]);

  // ── Descendants map: every artifact id -> all child ids beneath it.
  // Drives parent→child cascade selection (Epic selects all features +
  // stories under it; Feature selects all its stories).
  const descendantIdsById = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const epic of epics) {
      const featureIds: number[] = [];
      const storyIds: number[] = [];
      for (const feat of epic.features) {
        const featStoryIds = feat.stories.map((s) => s.id);
        if (feat.feature) featureIds.push(feat.feature.id);
        storyIds.push(...featStoryIds);
        if (feat.feature) {
          map.set(feat.feature.id, featStoryIds);
        }
      }
      const orphanIds = epic.orphanStories.map((s) => s.id);
      if (epic.epic) {
        map.set(epic.epic.id, [...featureIds, ...storyIds, ...orphanIds]);
      }
    }
    return map;
  }, [epics]);

  // ── Filtered epic tree ─────────────────────────────────────────────
  // Counters MUST equal what is rendered. To guarantee that we:
  //   • Keep every approved artifact in the visible tree — an approved
  //     epic / feature is never culled just because its children weren't
  //     also approved. (The dashboard shows the parent too.)
  //   • Apply search + filter chips uniformly across every node.
  //   • Drop a parent only when the parent ITSELF fails the active
  //     filter AND all its descendants are filtered out — i.e. nothing
  //     under it is selectable. That keeps counts == rendered items.
  const filteredEpics = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchText = (a: CBv2Artifact, extra = "") =>
      !q ||
      a.title.toLowerCase().includes(q) ||
      (a.description ?? "").toLowerCase().includes(q) ||
      extra.toLowerCase().includes(q);

    const passes = (a: CBv2Artifact, extra = "") =>
      applyArtifactFilter([a], filter).length > 0 && matchText(a, extra);

    return epics
      .map((ep) => {
        const features = ep.features
          .map((f) => {
            const stories = f.stories.filter((s) => passes(s, f.feature_name));
            const featureVisible =
              f.feature == null /* synthetic bucket */ ||
              passes(f.feature, ep.epic_name);
            // Keep this feature if it itself matches the filter, OR any
            // of its stories do. We don't want to silently swallow a
            // starred feature with no starred stories.
            if (!featureVisible && stories.length === 0) return null;
            return { ...f, stories };
          })
          .filter((f): f is FeatureGroup => f !== null);

        const orphanStories = ep.orphanStories.filter((s) => passes(s, ep.epic_name));
        const epicVisible = ep.epic == null || passes(ep.epic);

        // Keep an epic if the epic itself matches, OR any descendant
        // (feature / orphan story) is visible.
        if (!epicVisible && features.length === 0 && orphanStories.length === 0) {
          return null;
        }
        return { ...ep, features, orphanStories };
      })
      .filter((ep): ep is EpicNode => ep !== null);
  }, [epics, search, filter]);

  // Counts shown on the All / Starred / Flagged chips. We compute them
  // against the search-filtered tree (ignoring the active filter chip
  // itself) so each chip shows how many items it WOULD render. To do
  // that we re-derive the search-filtered set independent of `filter`.
  const filterCounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchText = (a: CBv2Artifact, extra = "") =>
      !q ||
      a.title.toLowerCase().includes(q) ||
      (a.description ?? "").toLowerCase().includes(q) ||
      extra.toLowerCase().includes(q);

    const searched: CBv2Artifact[] = [];
    for (const ep of epics) {
      const epicMatches = ep.epic ? matchText(ep.epic) : true;
      const matchedFeatures: FeatureGroup[] = [];
      for (const f of ep.features) {
        const matchedStories = f.stories.filter((s) => matchText(s, f.feature_name));
        const fMatches = f.feature ? matchText(f.feature, ep.epic_name) : true;
        if (fMatches || matchedStories.length > 0) {
          matchedFeatures.push({ ...f, stories: matchedStories });
        }
      }
      const matchedOrphans = ep.orphanStories.filter((s) => matchText(s, ep.epic_name));
      if (!epicMatches && matchedFeatures.length === 0 && matchedOrphans.length === 0) {
        continue;
      }
      if (ep.epic) searched.push(ep.epic);
      for (const f of matchedFeatures) {
        if (f.feature) searched.push(f.feature);
        for (const s of f.stories) searched.push(s);
      }
      for (const s of matchedOrphans) searched.push(s);
    }
    return getArtifactFilterCounts(searched);
  }, [epics, search]);

  const activeStory = allStories.find((s) => s.id === activeStoryId) ?? null;
  const allSelected = allStories.length > 0 && selectedIds.length === allStories.length;

  // ── Dependency check ───────────────────────────────────────────────
  const checkDependencies = useCallback(
    (ids: number[]): DependencyInfo | null => {
      // Rule 1: if ALL stories selected → no validation
      if (ids.length === allStories.length) return null;

      const selectedSet = new Set(ids);
      const missingDeps: CBv2Artifact[] = [];
      const allDeps: string[] = [];

      for (const id of ids) {
        const story = allStories.find((s) => s.id === id);
        if (!story?.content) continue;

        const content = story.content as Record<string, unknown>;
        const relationships = content.relationships as Record<string, unknown> | undefined;
        const blockedBy = (relationships?.blocked_by as string[]) || [];

        for (const depId of blockedBy) {
          allDeps.push(depId);
          // Match against artifact_id, numeric id, or content.story_id
          const depStory = allStories.find(
            (s) =>
              s.artifact_id === depId ||
              s.id === parseInt(depId, 10) ||
              (s.content as Record<string, unknown>)?.story_id === depId
          );

          if (depStory && !selectedSet.has(depStory.id)) {
            if (!missingDeps.find((d) => d.id === depStory.id)) {
              missingDeps.push(depStory);
            }
          }
        }
      }

      return missingDeps.length > 0
        ? { missingStories: missingDeps, allDependencies: allDeps }
        : null;
    },
    [allStories]
  );

  // ── Toggle story / feature / epic with parent→child cascade ──────
  // Selecting an Epic auto-selects its features + stories. Selecting a
  // Feature auto-selects its stories. Deselecting cascades the same way.
  // Indeterminate parents (some children selected) collapse to "all
  // selected" on click — matching standard tri-state checkbox UX.
  const toggleStory = useCallback(
    (id: number) => {
      setSelectedIds((prev) => {
        const descendants = descendantIdsById.get(id) ?? [];
        const cluster = [id, ...descendants];
        const prevSet = new Set(prev);
        const allSelected = cluster.every((c) => prevSet.has(c));

        let next: number[];
        if (allSelected) {
          // Fully selected → deselect entire cluster
          const clusterSet = new Set(cluster);
          next = prev.filter((sid) => !clusterSet.has(sid));
        } else {
          // Otherwise (none or partial) → select entire cluster
          next = Array.from(new Set([...prev, ...cluster]));
        }

        // Validate dependencies only when the net effect adds items
        if (next.length > prev.length) {
          const deps = checkDependencies(next);
          if (deps) {
            setPendingSelection(next);
            setDependencyInfo(deps);
            setShowDependencyDialog(true);
            return prev; // keep old until user decides
          }
        }

        return next;
      });
    },
    [checkDependencies, descendantIdsById]
  );

  // ── Toggle all ─────────────────────────────────────────────────────
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? [] : allStories.map((s) => s.id));
  }, [allSelected, allStories]);

  // ── Dependency dialog handlers ─────────────────────────────────────
  const handleIncludeDependencies = useCallback(() => {
    if (pendingSelection && dependencyInfo) {
      const depIds = dependencyInfo.missingStories.map((s) => s.id);
      setSelectedIds([...pendingSelection, ...depIds]);
    }
    setShowDependencyDialog(false);
    setPendingSelection(null);
    setDependencyInfo(null);
  }, [pendingSelection, dependencyInfo]);

  const handleExcludeDependencies = useCallback(() => {
    if (pendingSelection) setSelectedIds(pendingSelection);
    setShowDependencyDialog(false);
    setPendingSelection(null);
    setDependencyInfo(null);
  }, [pendingSelection]);

  const handleCloseDependencyDialog = useCallback(() => {
    setShowDependencyDialog(false);
    setPendingSelection(null);
    setDependencyInfo(null);
  }, []);

  // ── Done ───────────────────────────────────────────────────────────
  const handleDone = useCallback(() => {
    // Final dependency check before closing
    if (selectedIds.length > 0 && selectedIds.length < allStories.length) {
      const deps = checkDependencies(selectedIds);
      if (deps) {
        setPendingSelection(selectedIds);
        setDependencyInfo(deps);
        setShowDependencyDialog(true);
        return;
      }
    }

    const selected = allStories.filter((s) => selectedIds.includes(s.id));
    onStoriesSelected(selectedIds, selected);
    onClose();
  }, [selectedIds, allStories, checkDependencies, onStoriesSelected, onClose]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <>
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
                Project Artifacts
              </h2>
              <span className="px-2 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[11px] font-mono">
                {allStories.length} total
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
          <div className="flex items-center gap-3 px-4 py-2 border-b border-cbv2-border bg-cbv2-sidebar shrink-0 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
              <input
                className="w-full pl-8 pr-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${allStories.length} artifacts...`}
                autoFocus
              />
            </div>
            <ArtifactFilterChips
              value={filter}
              onChange={setFilter}
              counts={filterCounts}
              size="sm"
              visibleFilters={["starred"]}
            />
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cbv2-border text-[11px] hover:border-cbv2-accent/30 transition-colors text-cbv2-text-dim hover:text-cbv2-accent"
              onClick={toggleAll}
            >
              {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
              {allSelected ? "Deselect All" : "Select All"}
            </button>
          </div>

          {/* Body — split pane */}
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-[12px] text-cbv2-text-dim">Loading artifacts...</div>
            </div>
          ) : (
            <div className="flex-1 flex overflow-hidden">
              {/* Left: epic → feature → story tree (mirrors the
                  User Stories Job Dashboard hierarchy view, supporting
                  all four shapes: Story-only, Feature→Story,
                  Epic→Story, Epic→Feature→Story). */}
              <div className="w-[40%] border-r border-cbv2-border overflow-y-auto cbv2-scrollbar p-3 space-y-2">
                {filteredEpics.map((ep) => {
                  // "Standalone Features" → render the features inline as
                  // top-level cards (Feature→Story shape).
                  if (ep.epic_id === "__standalone_features__") {
                    return (
                      <div key={ep.epic_id} className="space-y-2">
                        {ep.features.map((feat) => (
                          <FeatureSection
                            key={feat.feature_id}
                            feature={feat}
                            activeId={activeStoryId}
                            selectedIds={selectedIds}
                            onToggle={toggleStory}
                            onView={setActiveStoryId}
                          />
                        ))}
                      </div>
                    );
                  }
                  // "Standalone Stories" → render stories inline as
                  // top-level cards (Story-only shape).
                  if (ep.epic_id === "__standalone_stories__") {
                    return (
                      <div key={ep.epic_id} className="space-y-1.5">
                        {ep.orphanStories.map((story) => (
                          <StoryRow
                            key={story.id}
                            story={story}
                            isSelected={selectedIds.includes(story.id)}
                            isActive={activeStoryId === story.id}
                            onToggle={() => toggleStory(story.id)}
                            onView={() => setActiveStoryId(story.id)}
                          />
                        ))}
                      </div>
                    );
                  }
                  // Real epic — Epic→Feature→Story or Epic→Story.
                  return (
                    <EpicSection
                      key={ep.epic_id}
                      epic={ep}
                      activeId={activeStoryId}
                      selectedIds={selectedIds}
                      onToggle={toggleStory}
                      onView={setActiveStoryId}
                    />
                  );
                })}
                {filteredEpics.length === 0 && (
                  <div className="flex items-center justify-center py-8 text-[11px] text-cbv2-text-dim">
                    {search
                      ? `No artifacts matching "${search}"`
                      : filter !== "all"
                        ? `No ${filter} artifacts in this project.`
                        : "No artifacts found for this project."}
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
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span
                            className={[
                              "text-[10px] px-2 py-0.5 rounded border font-medium",
                              TYPE_COLORS[activeStory.artifact_type] ??
                                "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
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
                          <RunFlagBadges
                            starred={activeStory.run_is_selected}
                            flagged={activeStory.run_review_flag}
                            approved={activeStory.approval_status === "approved"}
                            size="sm"
                          />
                        </div>
                      </div>
                      <button
                        className={[
                          "flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium transition-colors",
                          selectedIds.includes(activeStory.id)
                            ? "bg-cbv2-accent text-white"
                            : "bg-cbv2-input text-cbv2-text border border-cbv2-border hover:border-cbv2-accent/40",
                        ].join(" ")}
                        onClick={() => toggleStory(activeStory.id)}
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
                    Select an artifact from the list to view details
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-cbv2-border bg-cbv2-sidebar flex items-center justify-between shrink-0">
            <span className="text-[11px] text-cbv2-text-dim">
              {selectedIds.length} of {allStories.length} artifacts selected
            </span>
            <button
              className="px-4 py-1.5 rounded bg-cbv2-accent text-white text-[12px] font-medium hover:bg-cbv2-accent/80 transition-colors"
              onClick={handleDone}
            >
              Done
            </button>
          </div>
        </div>
      </div>

      {/* Dependency Dialog */}
      {showDependencyDialog && dependencyInfo && (
        <DependencyDialog
          dependencies={dependencyInfo.missingStories}
          onInclude={handleIncludeDependencies}
          onExclude={handleExcludeDependencies}
          onClose={handleCloseDependencyDialog}
        />
      )}
    </>
  );
}
