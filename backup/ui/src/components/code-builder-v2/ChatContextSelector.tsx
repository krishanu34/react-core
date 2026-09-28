"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useDbProjects } from "@/hooks/useDbProjects";
import { useCBv2ApprovedArtifacts, useProjectDocumentArtifacts } from "@/hooks/useCodeBuilderQueries";
import SessionPickerModal from "./SessionPickerModal";
import UserStoryViewerModal from "./UserStoryViewerModal";
import DocumentViewerModal from "./DocumentViewerModal";
import { listCBSessions, type CBSessionRun } from "@/lib/code-builder-api";
import type {
  CBv2ChatContext,
  CBv2PipelineType,
  CBv2Artifact,
} from "@/types/code-builder-v2";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  BookOpen,
  FileText,
  Layers,
  Loader2,
  Check,
  X,
  Search,
  RefreshCw,
  Eye,
  MessageSquare,
} from "lucide-react";

const DOC_TYPE_TO_CONTEXT_TYPE: Record<string, CBv2ChatContext["selected_doc_types"][number]> = {
  hld_document: "hld",
  lld_document: "lld",
  req_document: "srs",
  requirements_document: "srs",
  srs_document: "srs",
  ddd_document: "ddd",
  api_spec_document: "api_spec",
  test_plan_document: "test_plan",
};

/* ── Collapsible Section ──────────────────────────────────────────────── */

function Section({
  title,
  icon: Icon,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ElementType;
  badge?: string | number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-cbv2-border last:border-b-0">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-medium text-cbv2-text hover:bg-cbv2-hover transition-colors"
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-cbv2-text-dim flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-cbv2-text-dim flex-shrink-0" />
        )}
        <Icon className="w-3.5 h-3.5 text-cbv2-accent flex-shrink-0" />
        <span className="flex-1 text-left uppercase tracking-wide">{title}</span>
        {badge !== undefined && badge !== "" && (
          <span className="px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Project Item ─────────────────────────────────────────────────────── */

interface ProjectItem {
  id: number;
  name: string;
  description: string | null;
  has_code_context?: boolean;
  has_doc_context?: boolean;
  has_figma_context?: boolean;
}

/* ── Chat Context Selector ────────────────────────────────────────────── */

interface ChatContextSelectorProps {
  context: CBv2ChatContext;
  currentSessionId?: number | null;
  currentRunId?: string | null;
  onChange: (ctx: CBv2ChatContext) => void;
  onClose: () => void;
}

export default function ChatContextSelector({
  context,
  currentSessionId,
  currentRunId,
  onChange,
  onClose,
}: ChatContextSelectorProps) {
  // ── State ──────────────────────────────────────────────────────────
  const { projects: rawProjects, loading: loadingProjects, refresh: refreshProjects } = useDbProjects();
  const projects: ProjectItem[] = rawProjects
    .filter((p) => !p.description?.includes("[archived]"))
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      has_code_context: p.has_code_context,
      has_doc_context: p.has_doc_context,
      has_figma_context: p.has_figma_context,
    }));
  const [projectSearch, setProjectSearch] = useState("");

  const { data: approvedArtifacts = [], isLoading: loadingCount } = useCBv2ApprovedArtifacts(context.project_id);
  const storyCount = approvedArtifacts.length;

  const { data: documentArtifacts = [], isLoading: loadingDocCount } = useProjectDocumentArtifacts(context.project_id);
  const docCount = documentArtifacts.length;

  const [projectOpen, setProjectOpen] = useState(!context.project_id);
  const [pipelineOpen, setPipelineOpen] = useState(false);

  const [showStoryModal, setShowStoryModal] = useState(false);
  const [showDocModal, setShowDocModal] = useState(false);

  // ── Session picker modal state ─────────────────────────────────────
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionLabel, setSessionLabel] = useState<string | null>(null);
  // Cache: session id → name (so we don't re-fetch on every render)
  const [sessionNameCache, setSessionNameCache] = useState<Record<number, string>>({});
  const effectiveSessionId = currentSessionId ?? context.session_id ?? null;

  // Reset cached session name/label whenever the active project changes.
  // Without this, switching from project A (session 50 "foo") to project B
  // briefly displays "#50 — foo" while project B's auto-loaded session id
  // hasn't propagated yet — confusing the user into thinking the wrong
  // session is selected.
  useEffect(() => {
    setSessionLabel(null);
    setSessionNameCache({});
  }, [context.project_id]);

  // ── Resolve the session name whenever the active session id changes ─
  // Handles three cases:
  //   (a) auto-loaded most-recent session on project select,
  //   (b) SSE returning a freshly created session id for a new run,
  //   (c) modal pick (already sets sessionLabel directly).
  useEffect(() => {
    if (!context.project_id || !effectiveSessionId) return;
    if (sessionNameCache[effectiveSessionId]) {
      setSessionLabel(sessionNameCache[effectiveSessionId]);
      return;
    }
    let cancelled = false;
    listCBSessions(context.project_id, { limit: 20 })
      .then((data) => {
        if (cancelled) return;
        const next: Record<number, string> = {};
        for (const s of data.sessions) next[s.id] = s.session_name;
        setSessionNameCache((prev) => ({ ...prev, ...next }));
        const found = next[effectiveSessionId];
        if (found) setSessionLabel(found);
      })
      .catch(() => { /* leave sessionLabel as-is */ });
    return () => { cancelled = true; };
  }, [context.project_id, effectiveSessionId, sessionNameCache]);

  // ── Project selection ──────────────────────────────────────────────
  const handleProjectSelect = useCallback(
    (project: ProjectItem) => {
      onChange({
        ...context,
        project_id: project.id,
        project_name: project.name,
        selected_story_ids: [],
        selected_stories: [],
        selected_document_ids: [],
        selected_documents: [],
        selected_doc_types: [],
      });
    },
    [context, onChange]
  );

  // ── Pipeline type ──────────────────────────────────────────────────
  const setPipelineType = useCallback(
    (pt: CBv2PipelineType) => {
      onChange({ ...context, pipeline_type: pt });
    },
    [context, onChange]
  );

  // ── Filtered projects ──────────────────────────────────────────────
  const filteredProjects = projectSearch.trim()
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(projectSearch.toLowerCase())
      )
    : projects;

  const selectedProject = projects.find((p) => p.id === context.project_id);

  return (
    <div className="bg-cbv2-bg border-b border-cbv2-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-cbv2-sidebar border-b border-cbv2-border">
        <span className="text-[11px] font-medium text-cbv2-accent uppercase tracking-wide">
          Context
        </span>
        <button
          className="p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
          onClick={onClose}
          title="Close context panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Project (read-only — set from main app header) ──────────── */}
      <div className="border-b border-cbv2-border">
        <div className="flex items-center gap-2 px-3 py-2 text-[11px]">
          <FolderOpen className="w-3.5 h-3.5 text-cbv2-accent flex-shrink-0" />
          <span className="font-medium uppercase tracking-wide text-cbv2-text">Project</span>
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono truncate max-w-[180px]">
            {selectedProject?.name ?? "No project selected"}
          </span>
        </div>
        {!context.project_id && (
          <p className="px-3 pb-2 text-[10px] text-cbv2-text-dim">
            Select a project from the main app header.
          </p>
        )}
      </div>

      {/* ── Session (compact button → opens popup) ──────────────────── */}
      {context.project_id && (
        <div className="border-b border-cbv2-border">
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
            onClick={() => setShowSessionPicker(true)}
          >
            <MessageSquare className="w-3.5 h-3.5 text-cbv2-accent flex-shrink-0" />
            <span className="font-medium uppercase tracking-wide">Session</span>
            <span
              className="ml-auto px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono truncate max-w-[180px]"
              title={
                effectiveSessionId
                  ? `Session #${effectiveSessionId}${sessionLabel ? ` — ${sessionLabel}` : ""}`
                  : context.new_session_name
                    ? `New session — ${context.new_session_name}`
                    : "New session"
              }
            >
              {effectiveSessionId
                ? `#${effectiveSessionId}${sessionLabel ? ` — ${sessionLabel}` : ""}`
                : context.new_session_name
                  ? `New: ${context.new_session_name}`
                  : "New session"}
            </span>
          </button>
        </div>
      )}

      {/* Session Picker Modal */}
      {showSessionPicker && context.project_id && (
        <SessionPickerModal
          projectId={context.project_id}
          projectName={selectedProject?.name ?? "Project"}
          currentSessionId={effectiveSessionId}
          currentRunId={currentRunId}
          onSelect={(session, newName, selectedRun) => {
            if (session) {
              setSessionLabel(session.session_name || null);
              setSessionNameCache((prev) => ({ ...prev, [session.id]: session.session_name }));
              onChange({
                ...context,
                session_id: session.id,
                new_session_name: undefined,
                _session_output_dir: selectedRun?.output_dir ?? (session as any).last_output_dir ?? null,
                _session_run_id: selectedRun?.run_id ?? (session as any).last_run_id ?? null,
              } as any);
            } else {
              setSessionLabel(null);
              onChange({
                ...context,
                session_id: null,
                new_session_name: newName || "",
                _session_output_dir: null,
                _session_run_id: null,
                previous_output_dir: null,
              } as any);
            }
            setShowSessionPicker(false);
          }}
          onClose={() => setShowSessionPicker(false)}
        />
      )}

      {/* ── User Stories Section (click → opens modal) ──────────────── */}
      {context.project_id && (
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-cbv2-text border-b border-cbv2-border hover:bg-cbv2-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setShowStoryModal(true)}
          disabled={loadingCount || storyCount === 0}
          title={
            storyCount === 0
              ? "No approved user stories yet. Run the Story Builder first."
              : "Open approved user stories"
          }
        >
          <BookOpen className="w-3.5 h-3.5 text-cbv2-accent flex-shrink-0" />
          <span className="flex-1 text-left font-medium uppercase tracking-wide">
            Approved User Stories
          </span>
          {loadingCount ? (
            <Loader2 className="w-3 h-3 animate-spin text-cbv2-text-dim" />
          ) : (
            <span className="ml-auto px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono">
              {context.selected_story_ids.length > 0
                ? `${context.selected_story_ids.length}/${storyCount}`
                : storyCount}
            </span>
          )}
          <ChevronRight className="w-3 h-3 text-cbv2-text-dim flex-shrink-0" />
        </button>
      )}

      {/* ── Documents Section (click → opens modal) ─────────────────── */}
      {context.project_id && (
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-cbv2-text border-b border-cbv2-border hover:bg-cbv2-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setShowDocModal(true)}
          disabled={loadingDocCount || docCount === 0}
          title={
            docCount === 0
              ? "No approved documents yet. Run the Document Builder first."
              : "Open approved documents"
          }
        >
          <FileText className="w-3.5 h-3.5 text-cbv2-accent flex-shrink-0" />
          <span className="flex-1 text-left font-medium uppercase tracking-wide">
            Approved Documents
          </span>
          {loadingDocCount ? (
            <Loader2 className="w-3 h-3 animate-spin text-cbv2-text-dim" />
          ) : (
            <span className="ml-auto px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono">
              {context.selected_document_ids.length > 0
                ? `${context.selected_document_ids.length}/${docCount}`
                : docCount}
            </span>
          )}
          <ChevronRight className="w-3 h-3 text-cbv2-text-dim flex-shrink-0" />
        </button>
      )}

      {/* Pipeline type is auto-detected from user prompt — no manual selection needed */}

      {/* ── Context Summary Bar ───────────────────────────────────────── */}
      {context.project_id && (
        <div className="px-3 py-1.5 bg-cbv2-accent/5 text-[10px] text-cbv2-text-dim flex items-center gap-2 flex-wrap">
          <span className="font-medium text-cbv2-accent">
            {selectedProject?.name}
          </span>
          {context.selected_story_ids.length > 0 && (
            <>
              <span>·</span>
              <span>{context.selected_story_ids.length} stories</span>
            </>
          )}
          {context.selected_document_ids.length > 0 && (
            <>
              <span>·</span>
              <span>{context.selected_document_ids.length} docs</span>
            </>
          )}
        </div>
      )}

      {/* ── Story Viewer Modal ────────────────────────────────────────── */}
      {showStoryModal && context.project_id && (
        <UserStoryViewerModal
          projectId={context.project_id}
          initialSelectedIds={context.selected_story_ids}
          onClose={() => setShowStoryModal(false)}
          onStoriesSelected={(ids: number[], arts: CBv2Artifact[]) => {
            onChange({
              ...context,
              selected_story_ids: ids,
              selected_stories: arts,
            });
            setShowStoryModal(false);
          }}
        />
      )}

      {/* ── Document Viewer Modal ─────────────────────────────────────── */}
      {showDocModal && context.project_id && (
        <DocumentViewerModal
          projectId={context.project_id}
          initialSelectedIds={context.selected_document_ids}
          onClose={() => setShowDocModal(false)}
          onDocumentsSelected={(ids: number[], docs: CBv2Artifact[]) => {
            const nextDocTypes = Array.from(
              new Set(
                docs
                  .map((doc) => DOC_TYPE_TO_CONTEXT_TYPE[doc.artifact_type])
                  .filter(Boolean),
              ),
            );
            onChange({
              ...context,
              selected_document_ids: ids,
              selected_documents: docs,
              selected_doc_types: nextDocTypes,
            });
            setShowDocModal(false);
          }}
        />
      )}
    </div>
  );
}
