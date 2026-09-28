"use client";

import React, { useState, useCallback, useEffect } from "react";
import type {
  CBv2PipelineConfig,
  CBv2PipelineType,
  CBv2DocumentType,
  CBv2Project,
  CBv2Artifact,
  CBv2StorySelection,
} from "@/types/code-builder-v2";
import UserStoryViewerModal from "@/components/code-builder-v2/UserStoryViewerModal";
import { useDbProjects } from "@/hooks/useDbProjects";
import {
  useCBv2Configs,
  useSaveCBv2Config,
  useCBv2ApprovedArtifacts,
} from "@/hooks/useCodeBuilderQueries";
import {
  Settings,
  FolderKanban,
  FileText,
  BookOpen,
  Layers,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronRight,
  Save,
  Plus,
  Trash2,
  Loader2,
  Construction,
  Rocket,
  AlertCircle,
  Eye,
} from "lucide-react";

/* ── Constants ────────────────────────────────────────────────────────── */

const PIPELINE_TYPES: { value: CBv2PipelineType; label: string; icon: React.ReactNode; desc: string; enabled: boolean }[] = [
  { value: "greenfield", label: "Greenfield", icon: <Rocket className="w-4 h-4" />, desc: "New project from scratch", enabled: true },
  { value: "brownfield", label: "Brownfield", icon: <Construction className="w-4 h-4" />, desc: "Modify existing codebase", enabled: true },
];

const DOCUMENT_TYPES: { value: CBv2DocumentType; label: string }[] = [
  { value: "hld", label: "High-Level Design (HLD)" },
  { value: "lld", label: "Low-Level Design (LLD)" },
  { value: "srs", label: "Software Requirements Spec (SRS)" },
  { value: "ddd", label: "Domain-Driven Design (DDD)" },
  { value: "api_spec", label: "API Specification" },
  { value: "test_plan", label: "Test Plan" },
];

/* ── Props ────────────────────────────────────────────────────────────── */

interface ConfigPanelProps {
  onConfigApply: (config: CBv2PipelineConfig) => void;
}

/* ── Section Component ────────────────────────────────────────────────── */

function Section({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-cbv2-border">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[12px] font-semibold text-cbv2-text hover:bg-cbv2-hover transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {icon}
        <span className="uppercase tracking-wide">{title}</span>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

/* ── Main ConfigPanel ─────────────────────────────────────────────────── */

export default function ConfigPanel({ onConfigApply }: ConfigPanelProps) {
  // ── React Query hooks ──────────────────────────────────────────────────
  const { projects: rawProjects } = useDbProjects();
  const projects = rawProjects as unknown as CBv2Project[];
  const { data: configs = [] } = useCBv2Configs();
  const saveMutation = useSaveCBv2Config();

  // ── State ──────────────────────────────────────────────────────────────
  const [selectedConfigId, setSelectedConfigId] = useState<number | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const { data: stories = [], isLoading: loadingStories } = useCBv2ApprovedArtifacts(selectedProjectId);
  const [selectedStories, setSelectedStories] = useState<Set<number>>(new Set());
  const [pipelineType, setPipelineType] = useState<CBv2PipelineType>("greenfield");
  const [selectedDocs, setSelectedDocs] = useState<Set<CBv2DocumentType>>(new Set());
  const [configName, setConfigName] = useState("My Config");
  const [showStoryViewerModal, setShowStoryViewerModal] = useState(false);

  // ── Reset stories when project changes ─────────────────────────────────
  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedStories(new Set());
    }
  }, [selectedProjectId]);

  // ── Save config via mutation ───────────────────────────────────────────
  const saveConfig = async () => {
    saveMutation.mutate({
      name: configName,
      project_id: selectedProjectId,
      pipeline_type: pipelineType,
      document_types: Array.from(selectedDocs),
      tech_stack: {},
      settings: {},
      story_artifact_ids: Array.from(selectedStories),
    });
  };

  // ── Toggle helpers ─────────────────────────────────────────────────────
  const toggleStory = useCallback((id: number) => {
    setSelectedStories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleDoc = useCallback((doc: CBv2DocumentType) => {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(doc)) next.delete(doc);
      else next.add(doc);
      return next;
    });
  }, []);

  const toggleAllStories = useCallback(() => {
    if (selectedStories.size === stories.length) {
      setSelectedStories(new Set());
    } else {
      setSelectedStories(new Set(stories.map((s) => s.id)));
    }
  }, [stories, selectedStories]);

  // ── Apply a saved config ───────────────────────────────────────────────
  const applyConfig = useCallback(
    (config: CBv2PipelineConfig) => {
      setSelectedConfigId(config.id);
      setConfigName(config.name);
      setPipelineType(config.pipeline_type);
      setSelectedDocs(new Set(config.document_types));
      if (config.project_id) setSelectedProjectId(config.project_id);
      onConfigApply(config);
    },
    [onConfigApply]
  );

  // ── Build current config object ────────────────────────────────────────
  const getCurrentConfig = useCallback((): CBv2PipelineConfig => {
    return {
      id: selectedConfigId || 0,
      name: configName,
      project_id: selectedProjectId || undefined,
      pipeline_type: pipelineType,
      document_types: Array.from(selectedDocs),
      tech_stack: {},
      settings: {},
      story_artifact_ids: Array.from(selectedStories),
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }, [selectedConfigId, configName, selectedProjectId, pipelineType, selectedDocs, selectedStories]);

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-cbv2-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-cbv2-accent" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">
            Configuration
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={saveConfig}
            title="Save Configuration"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto cbv2-scrollbar">
        {/* ── Saved Configs ───────────────────────────────────────── */}
        <Section title="Saved Configurations" icon={<FolderKanban className="w-3.5 h-3.5 text-cbv2-accent" />} defaultOpen={configs.length > 0}>
          {configs.length === 0 ? (
            <p className="text-[11px] text-cbv2-text-dim py-1">No saved configurations. Configure and save one below.</p>
          ) : (
            <div className="space-y-1">
              {configs.map((cfg) => (
                <button
                  key={cfg.id}
                  className={[
                    "w-full text-left px-3 py-2 rounded text-[11px] transition-colors border",
                    selectedConfigId === cfg.id
                      ? "bg-cbv2-accent/15 border-cbv2-accent/40 text-cbv2-accent"
                      : "bg-cbv2-input border-cbv2-border hover:border-cbv2-accent/30 text-cbv2-text",
                  ].join(" ")}
                  onClick={() => applyConfig(cfg)}
                >
                  <div className="font-medium">{cfg.name}</div>
                  <div className="text-cbv2-text-dim mt-0.5 flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-cbv2-accent/10 text-cbv2-accent text-[10px]">
                      {cfg.pipeline_type}
                    </span>
                    {cfg.document_types.length > 0 && (
                      <span>{cfg.document_types.length} docs</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* ── Config Name ─────────────────────────────────────────── */}
        <Section title="Config Name" icon={<FileText className="w-3.5 h-3.5 text-blue-400" />}>
          <input
            className="w-full px-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text focus:border-cbv2-accent outline-none"
            value={configName}
            onChange={(e) => setConfigName(e.target.value)}
            placeholder="Configuration name"
          />
        </Section>

        {/* ── Project Selection ────────────────────────────────────── */}
        <Section title="Project" icon={<FolderKanban className="w-3.5 h-3.5 text-yellow-400" />}>
          {projects.length === 0 ? (
            <p className="text-[11px] text-cbv2-text-dim py-1">No projects found. Create one in DevAccel first.</p>
          ) : (
            <div className="space-y-1 max-h-[160px] overflow-y-auto cbv2-scrollbar">
              {projects.map((proj) => (
                <button
                  key={proj.id}
                  className={[
                    "w-full text-left px-3 py-1.5 rounded text-[11px] transition-colors",
                    selectedProjectId === proj.id
                      ? "bg-cbv2-accent/15 text-cbv2-accent"
                      : "hover:bg-cbv2-hover text-cbv2-text",
                  ].join(" ")}
                  onClick={() => setSelectedProjectId(proj.id)}
                >
                  <span className="font-medium">{proj.name}</span>
                  {proj.description && (
                    <span className="block text-cbv2-text-dim truncate">{proj.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* ── User Stories ─────────────────────────────────────────── */}
        <Section title="User Stories" icon={<BookOpen className="w-3.5 h-3.5 text-green-400" />}>
          {!selectedProjectId ? (
            <p className="text-[11px] text-cbv2-text-dim py-1">Select a project first to see user stories.</p>
          ) : loadingStories ? (
            <div className="flex items-center gap-2 py-2 text-[11px] text-cbv2-text-dim">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading stories...
            </div>
          ) : stories.length === 0 ? (
            <p className="text-[11px] text-cbv2-text-dim py-1">No user stories generated for this project.</p>
          ) : (
            <>
              {/* View All Button */}
              <button
                className="w-full flex items-center justify-center gap-2 px-3 py-2 mb-2 rounded bg-cbv2-accent/10 border border-cbv2-accent/30 text-cbv2-accent text-[11px] font-medium hover:bg-cbv2-accent/20 transition-colors"
                onClick={() => setShowStoryViewerModal(true)}
              >
                <Eye className="w-3.5 h-3.5" />
                View All Stories ({stories.length})
              </button>
              {/* Select All */}
              <button
                className="flex items-center gap-2 text-[11px] text-cbv2-text-dim hover:text-cbv2-text mb-1.5 transition-colors"
                onClick={toggleAllStories}
              >
                {selectedStories.size === stories.length ? (
                  <CheckSquare className="w-3.5 h-3.5 text-cbv2-accent" />
                ) : (
                  <Square className="w-3.5 h-3.5" />
                )}
                Select All ({stories.length})
              </button>
              <div className="space-y-0.5 max-h-[200px] overflow-y-auto cbv2-scrollbar">
                {stories.map((story) => (
                  <button
                    key={story.id}
                    className={[
                      "w-full text-left flex items-start gap-2 px-2 py-1.5 rounded text-[11px] transition-colors",
                      selectedStories.has(story.id)
                        ? "bg-cbv2-accent/10 text-cbv2-text"
                        : "hover:bg-cbv2-hover text-cbv2-text-dim",
                    ].join(" ")}
                    onClick={() => toggleStory(story.id)}
                  >
                    {selectedStories.has(story.id) ? (
                      <CheckSquare className="w-3.5 h-3.5 text-cbv2-accent shrink-0 mt-0.5" />
                    ) : (
                      <Square className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate">{story.title}</div>
                      <div className="text-cbv2-text-dim text-[10px] truncate">
                        {story.artifact_type} · ID: {story.id}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] text-cbv2-text-dim">
                {selectedStories.size} of {stories.length} selected
              </div>
            </>
          )}
        </Section>

        {/* ── Pipeline Type ────────────────────────────────────────── */}
        <Section title="Pipeline Type" icon={<Layers className="w-3.5 h-3.5 text-purple-400" />}>
          <div className="space-y-1.5">
            {PIPELINE_TYPES.map((pt) => (
              <button
                key={pt.value}
                disabled={!pt.enabled}
                className={[
                  "w-full text-left flex items-center gap-3 px-3 py-2.5 rounded border text-[11px] transition-colors",
                  !pt.enabled
                    ? "opacity-50 cursor-not-allowed border-cbv2-border bg-cbv2-input"
                    : pipelineType === pt.value
                      ? "bg-cbv2-accent/15 border-cbv2-accent/40 text-cbv2-accent"
                      : "border-cbv2-border hover:border-cbv2-accent/30 bg-cbv2-input text-cbv2-text",
                ].join(" ")}
                onClick={() => pt.enabled && setPipelineType(pt.value)}
              >
                <div className={pipelineType === pt.value ? "text-cbv2-accent" : "text-cbv2-text-dim"}>
                  {pt.icon}
                </div>
                <div>
                  <div className="font-medium flex items-center gap-2">
                    {pt.label}
                    {!pt.enabled && (
                      <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[9px] font-semibold">
                        COMING SOON
                      </span>
                    )}
                  </div>
                  <div className="text-cbv2-text-dim text-[10px]">{pt.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </Section>

        {/* ── Document Types ───────────────────────────────────────── */}
        <Section title="Documents" icon={<FileText className="w-3.5 h-3.5 text-orange-400" />}>
          <div className="space-y-1">
            {DOCUMENT_TYPES.map((dt) => (
              <button
                key={dt.value}
                className={[
                  "w-full text-left flex items-center gap-2 px-3 py-1.5 rounded text-[11px] transition-colors",
                  selectedDocs.has(dt.value)
                    ? "bg-cbv2-accent/10 text-cbv2-text"
                    : "hover:bg-cbv2-hover text-cbv2-text-dim",
                ].join(" ")}
                onClick={() => toggleDoc(dt.value)}
              >
                {selectedDocs.has(dt.value) ? (
                  <CheckSquare className="w-3.5 h-3.5 text-cbv2-accent" />
                ) : (
                  <Square className="w-3.5 h-3.5" />
                )}
                {dt.label}
              </button>
            ))}
          </div>
          {selectedDocs.size > 0 && (
            <div className="mt-1.5 text-[10px] text-cbv2-text-dim">
              {selectedDocs.size} document type(s) selected
            </div>
          )}
        </Section>
      </div>

      {/* Footer — Apply button */}
      <div className="px-4 py-3 border-t border-cbv2-border shrink-0">
        <button
          className="w-full py-2 rounded-lg bg-cbv2-accent text-white text-[12px] font-medium hover:bg-cbv2-accent/80 transition-colors flex items-center justify-center gap-2"
          onClick={() => onConfigApply(getCurrentConfig())}
        >
          <Rocket className="w-4 h-4" />
          Apply & Start Building
        </button>
        <div className="mt-2 flex gap-2">
          <button
            className="flex-1 py-1.5 rounded bg-cbv2-input text-cbv2-text-dim text-[11px] hover:text-cbv2-text hover:bg-cbv2-hover transition-colors flex items-center justify-center gap-1.5"
            onClick={saveConfig}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save Config
          </button>
        </div>
      </div>

      {/* User Story Viewer Modal */}
      {showStoryViewerModal && selectedProjectId && (
        <UserStoryViewerModal
          projectId={selectedProjectId}
          initialSelectedIds={Array.from(selectedStories)}
          onClose={() => setShowStoryViewerModal(false)}
          onStoriesSelected={(ids: number[]) => {
            setSelectedStories(new Set(ids));
            setShowStoryViewerModal(false);
          }}
        />
      )}
    </div>
  );
}
