"use client";

/**
 * ProjectsPanel — project dropdown → stories + documents for selected project.
 * Mirrors the Code Builder's ChatContextSelector pattern:
 *   1. Select a project from searchable dropdown
 *   2. See approved stories + documents for that project
 *   3. Click "Select" to open picker modals for detailed selection
 */
import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight, Loader2, FileText, BookOpen,
  CheckCircle2, Clock, FolderKanban, RefreshCw,
  MousePointerClick,
} from "lucide-react";
import { useGlobalProject } from "@/providers/ProjectProvider";
import {
  useCBv2ApprovedArtifacts,
  useProjectDocumentArtifacts,
  type CBv2ArtifactItem,
} from "@/hooks/useCodeBuilderQueries";
import { StoryPickerModal } from "@/components/ide/StoryPickerModal";
import { DocPickerModal } from "@/components/ide/DocPickerModal";

/* ── Artifact type detection ─────────────────────────────────────────── */
const DOC_TYPES = new Set([
  "hld_document", "lld_document", "req_document", "requirements_document",
  "srs_document", "ddd_document", "api_spec_document", "test_plan_document",
]);
const isDocArtifact = (a: CBv2ArtifactItem) =>
  DOC_TYPES.has(a.artifact_type) || a.artifact_type.endsWith("_document");
const isStoryArtifact = (a: CBv2ArtifactItem) =>
  ["epic", "feature", "user_story", "story"].includes(a.artifact_type);

const DOC_SHORT: Record<string, string> = {
  hld_document: "HLD", lld_document: "LLD", req_document: "REQ",
  requirements_document: "REQ", srs_document: "SRS", ddd_document: "DDD",
  api_spec_document: "API", test_plan_document: "TEST",
};

/* ── Selection state ─────────────────────────────────────────────────── */
export interface ProjectSelection {
  projectId: number;
  projectName: string;
  selectedStoryIds: Set<number>;
  selectedDocIds: Set<number>;
}

function ApprovalBadge({ approved }: { approved: boolean }) {
  return approved
    ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
    : <Clock className="h-3 w-3 text-amber-400 shrink-0" />;
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  ProjectArtifacts — stories + documents for the selected project
 * ══════════════════════════════════════════════════════════════════════ */
function ProjectArtifacts({
  projectId,
  projectName,
  selection,
  onSelectionChange,
}: {
  projectId: number;
  projectName: string;
  selection: ProjectSelection | undefined;
  onSelectionChange: (sel: ProjectSelection) => void;
}) {
  const { data: storyArtifacts, isLoading: storiesLoading } = useCBv2ApprovedArtifacts(projectId);
  const { data: documentArtifacts, isLoading: documentsLoading } = useProjectDocumentArtifacts(projectId);
  const [showStoryPicker, setShowStoryPicker] = useState(false);
  const [showDocPicker, setShowDocPicker] = useState(false);

  const stories = useMemo(() => (storyArtifacts ?? []).filter(isStoryArtifact), [storyArtifacts]);
  const docs = useMemo(() => (documentArtifacts ?? []).filter(isDocArtifact), [documentArtifacts]);
  const selectedStoryIds = selection?.selectedStoryIds ?? new Set<number>();
  const selectedDocIds = selection?.selectedDocIds ?? new Set<number>();

  if (storiesLoading || documentsLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-3 text-[var(--ide-muted)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-[10px]">Loading artifacts…</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">

      {/* ── User Stories section ────────────────────────────── */}
      <div className="rounded-md border border-[var(--ide-border)] overflow-hidden">
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--ide-surface)]">
          <div className="flex items-center gap-1.5">
            <BookOpen className="h-3 w-3 text-violet-400" />
            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] font-medium">
              User Stories
            </span>
            <span className="text-[9px] px-1.5 py-px rounded-full bg-violet-600/20 text-violet-300">
              {selectedStoryIds.size > 0 ? `${selectedStoryIds.size} selected` : stories.length}
            </span>
          </div>
          {stories.length > 0 && (
            <button type="button" onClick={() => setShowStoryPicker(true)}
              className="inline-flex items-center gap-1 text-[10px] text-violet-400 hover:text-violet-300 transition-colors">
              <MousePointerClick className="h-3 w-3" /> Select
            </button>
          )}
        </div>
      </div>

      {/* ── Documents section ──────────────────────────────── */}
      <div className="rounded-md border border-[var(--ide-border)] overflow-hidden">
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--ide-surface)]">
          <div className="flex items-center gap-1.5">
            <FileText className="h-3 w-3 text-teal-400" />
            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] font-medium">
              Documents
            </span>
            <span className="text-[9px] px-1.5 py-px rounded-full bg-teal-600/20 text-teal-300">
              {selectedDocIds.size > 0 ? `${selectedDocIds.size} selected` : docs.length}
            </span>
          </div>
          {docs.length > 0 && (
            <button type="button" onClick={() => setShowDocPicker(true)}
              className="inline-flex items-center gap-1 text-[10px] text-teal-400 hover:text-teal-300 transition-colors">
              <MousePointerClick className="h-3 w-3" /> Select
            </button>
          )}
        </div>
      </div>

      {/* ── Picker modals (portaled to body to escape sidebar stacking context) */}
      {showStoryPicker && typeof document !== "undefined" && createPortal(
        <StoryPickerModal
          stories={stories}
          selectedIds={selectedStoryIds}
          onDone={(ids) => onSelectionChange({
            projectId, projectName,
            selectedStoryIds: ids,
            selectedDocIds,
          })}
          onClose={() => setShowStoryPicker(false)}
        />,
        document.body,
      )}
      {showDocPicker && typeof document !== "undefined" && createPortal(
        <DocPickerModal
          documents={docs}
          selectedIds={selectedDocIds}
          onDone={(ids) => onSelectionChange({
            projectId, projectName,
            selectedStoryIds,
            selectedDocIds: ids,
          })}
          onClose={() => setShowDocPicker(false)}
        />,
        document.body,
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  ProjectsPanel — main sidebar component
 * ══════════════════════════════════════════════════════════════════════ */
export function ProjectsPanel() {
  const {
    projects, loading, refresh,
    selectedProjectId, selectedProject,
    projectSelection, setProjectSelection,
  } = useGlobalProject();

  const handleSelectionChange = useCallback((sel: ProjectSelection) => {
    setProjectSelection(sel);
  }, [setProjectSelection]);

  const totalSelected = (projectSelection?.selectedStoryIds.size ?? 0) + (projectSelection?.selectedDocIds.size ?? 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--ide-muted)]">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-[11px]">Loading projects…</span>
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="px-3 py-6 text-center space-y-2">
        <FolderKanban className="h-8 w-8 text-[var(--ide-muted)] mx-auto" />
        <p className="text-[11px] text-[var(--ide-muted)]">No projects found</p>
        <p className="text-[10px] text-[var(--ide-muted)]">
          Projects are created in the main application.
        </p>
        <button type="button" onClick={() => refresh()}
          className="inline-flex items-center gap-1 text-[10px] text-violet-400 hover:text-violet-300">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Project (read-only — set from main app header) ── */}
      <div className="shrink-0 px-3 py-2 border-b border-[var(--ide-border)] space-y-1.5">
        <span className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase">
          Project
        </span>

        {selectedProject ? (
          <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs">
            <FolderKanban className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="flex-1 truncate text-[var(--ide-text)] font-medium">
              {selectedProject.name}
            </span>
            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
          </div>
        ) : (
          <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-dashed border-[var(--ide-border)] text-xs text-[var(--ide-muted)]">
            <FolderKanban className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">No project selected</span>
          </div>
        )}

        <p className="text-[9px] text-[var(--ide-muted)]">
          Change project from the main app header.
        </p>
      </div>

      {/* ── Artifacts for selected project ────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {selectedProjectId ? (
          <ProjectArtifacts
            projectId={selectedProjectId}
            projectName={selectedProject?.name ?? ""}
            selection={projectSelection ?? undefined}
            onSelectionChange={handleSelectionChange}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2">
            <FolderKanban className="h-6 w-6 text-[var(--ide-muted)]" />
            <p className="text-[11px] text-[var(--ide-muted)]">
              Select a project to view<br />stories and documents
            </p>
          </div>
        )}
      </div>

      {/* ── Selection summary ─────────────────────────────── */}
      {totalSelected > 0 && (
        <div className="shrink-0 px-3 py-2 border-t border-[var(--ide-border)]">
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--ide-muted)]">
            <CheckCircle2 className="h-3 w-3 text-violet-400" />
            <span>
              {projectSelection?.selectedStoryIds.size ?? 0} stories, {projectSelection?.selectedDocIds.size ?? 0} docs selected
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectsPanel;
