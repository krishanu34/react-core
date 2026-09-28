"use client";

import React, { useMemo, useState } from "react";
import type { CBv2GenerationStatus } from "@/types/code-builder-v2";
import type {
  LegacyModernizationDraft,
  LegacyModernizationProject,
  LegacyModernizationStartRequest,
} from "@/types/legacy-modernization";
import {
  useLegacyModProjects,
  useLegacyModCodeContext,
} from "@/hooks/useLegacyModernizationQueries";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";

function getProjectEligibilityLabel(project: LegacyModernizationProject): string {
  const configuredLabel = String(project.legacy_modernization_model_label ?? "").trim();
  const modelName = String(project.legacy_modernization_model_name ?? "").trim();
  const vendor = String(project.legacy_modernization_model_vendor ?? "").trim();
  const message = String(project.modernization_validation_message ?? "").toLowerCase();
  if (project.modernization_eligible === true || project.legacy_modernization_model_configured === true) {
    if (configuredLabel) return configuredLabel;
    if (modelName && vendor) return `${modelName} (${vendor})`;
    if (modelName) return modelName;
    if (vendor) return vendor;
    return "Model details unavailable";
  }
  if (message.includes("inactive")) return "Model inactive";
  if (message.includes("no 'base' model") || message.includes("no ai model is configured") || message.includes("no ai models are configured")) {
    return "Model missing";
  }
  if (message.includes("no settings configured")) return "Setup missing";
  if (project.legacy_modernization_model_configured === false || project.modernization_eligible === undefined) return "Model missing";
  return "Not eligible";
}

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
        {badge !== undefined && badge !== "" ? (
          <span className="px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[10px] font-mono">
            {badge}
          </span>
        ) : null}
      </button>
      {open ? <div className="px-3 pb-2 pt-0.5">{children}</div> : null}
    </div>
  );
}

interface ModernizationContextSelectorProps {
  draft: LegacyModernizationDraft;
  summary: Record<string, unknown> | null;
  status: CBv2GenerationStatus;
  onDraftChange: (patch: Partial<LegacyModernizationDraft>) => void;
  onStart: (request: LegacyModernizationStartRequest) => void;
  onClose: () => void;
}

export default function ModernizationContextSelector({
  draft,
  summary,
  status,
  onDraftChange,
  onStart: _onStart,
  onClose,
}: ModernizationContextSelectorProps) {
  const {
    data: projects = [],
    isLoading: projectsLoading,
    error: projectsQueryError,
    refetch: refreshProjects,
  } = useLegacyModProjects();
  const projectsError = projectsQueryError ? (projectsQueryError as Error).message : "";

  const {
    data: codeContext = null,
    isLoading: codeContextLoading,
    error: codeContextQueryError,
    refetch: refreshCodeContext,
  } = useLegacyModCodeContext(draft.projectId > 0 ? draft.projectId : null);
  const codeContextError = codeContextQueryError ? (codeContextQueryError as Error).message : "";

  const [projectSearch, setProjectSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(!draft.projectId);
  const [contextOpen, setContextOpen] = useState(Boolean(draft.projectId));

  const isRunning = status === "running" || status === "connecting";

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const term = projectSearch.trim().toLowerCase();
    return projects.filter((project) =>
      String(project.project_name ?? "").toLowerCase().includes(term)
    );
  }, [projectSearch, projects]);

  const selectedProject = useMemo(() => {
    return projects.find((project) => Number(project.project_id) === Number(draft.projectId)) ?? null;
  }, [draft.projectId, projects]);

  return (
    <div className="bg-cbv2-bg border-b border-cbv2-border">
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

      <Section
        title="Project"
        icon={FolderOpen}
        badge={selectedProject?.project_name ?? "None"}
        open={projectOpen}
        onToggle={() => setProjectOpen((value) => !value)}
      >
        <div className="relative mb-1.5">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
          <input
            className="w-full pl-6 pr-7 py-1 bg-cbv2-input border border-cbv2-border rounded text-[11px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
            value={projectSearch}
            onChange={(event) => setProjectSearch(event.target.value)}
            placeholder="Search projects..."
          />
          <button
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim"
            onClick={() => void refreshProjects()}
            title="Refresh"
          >
            <RefreshCw className={["w-3 h-3", projectsLoading ? "animate-spin" : ""].join(" ")} />
          </button>
        </div>

        {projectsError ? (
          <div className="py-2 text-[11px] text-red-400">{projectsError}</div>
        ) : projectsLoading ? (
          <div className="flex items-center gap-2 py-2 text-[11px] text-cbv2-text-dim">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading projects...
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="py-2 text-[11px] text-cbv2-text-dim text-center">
            No projects found
          </div>
        ) : (
          <div className="max-h-[140px] overflow-y-auto cbv2-scrollbar space-y-0.5">
            {filteredProjects.map((project) => {
              const isSelected = Number(project.project_id) === Number(draft.projectId);
              const isEligible = project.modernization_eligible === true;
              const validationMessage = String(project.modernization_validation_message ?? "").trim();
              return (
                <button
                  key={String(project.project_id)}
                  className={[
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors text-left",
                    isSelected
                      ? "bg-cbv2-accent/15 text-cbv2-accent border border-cbv2-accent/30"
                      : isEligible
                        ? "text-cbv2-text hover:bg-cbv2-hover border border-transparent"
                        : "text-cbv2-text-dim border border-transparent opacity-60 cursor-not-allowed",
                  ].join(" ")}
                  onClick={() => {
                    if (!isEligible) return;
                    onDraftChange({ projectId: Number(project.project_id) });
                    setProjectOpen(false);
                    setContextOpen(true);
                  }}
                  disabled={!isEligible}
                  title={!isEligible && validationMessage ? validationMessage : undefined}
                >
                  <FolderOpen className="w-3 h-3 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">
                      {String(project.project_name ?? `Project ${project.project_id}`)}
                    </div>
                    <div className="truncate text-[10px] text-cbv2-text-dim">
                      ID {project.project_id} . {getProjectEligibilityLabel(project)}
                    </div>
                  </div>
                  {isSelected ? <Check className="w-3 h-3 text-cbv2-accent flex-shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Code Context"
        icon={Sparkles}
        badge={codeContext?.stored ? "Ready" : draft.projectId ? "Missing" : "None"}
        open={contextOpen}
        onToggle={() => setContextOpen((value) => !value)}
      >
        {!draft.projectId || draft.projectId <= 0 ? (
          <div className="py-2 text-[11px] text-cbv2-text-dim">
            Select a project to inspect its indexed code context.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="text-cbv2-text-dim">
                {codeContextLoading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking code context...
                  </span>
                ) : codeContext?.stored ? (
                  <span className="text-green-400">Code context ready</span>
                ) : (
                  <span className="text-yellow-400">Code context missing</span>
                )}
              </div>
              <button
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                onClick={() => void refreshCodeContext()}
                disabled={isRunning || codeContextLoading}
                title="Refresh code context"
              >
                <RefreshCw className={["w-3.5 h-3.5", codeContextLoading ? "animate-spin" : ""].join(" ")} />
              </button>
            </div>

            {codeContextError ? (
              <div className="text-[11px] text-red-400">{codeContextError}</div>
            ) : null}

            {codeContext ? (
              <div className="rounded bg-cbv2-input/60 border border-cbv2-border px-2 py-2 text-[11px] text-cbv2-text-dim">
                <div>
                  {typeof codeContext.total_files === "number"
                    ? `${codeContext.total_files} indexed files`
                    : `${codeContext.files.length} indexed files`}
                  {typeof codeContext.total_chunks === "number"
                    ? ` . ${codeContext.total_chunks} chunks`
                    : ""}
                </div>
                {!codeContext.stored ? (
                  <div className="mt-1">
                    Upload a repo ZIP or provide a GitHub link in Project Context, then refresh here.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {summary?.workspace_root ? (
        <div className="px-3 py-1.5 bg-cbv2-accent/5 text-[10px] text-cbv2-text-dim flex items-center gap-2 flex-wrap">
          <span className="font-medium text-cbv2-accent">Workspace ready</span>
          <span>. Reverse engineering artifacts can be reused from this session.</span>
        </div>
      ) : (
        <div className="px-3 py-1.5 bg-cbv2-accent/5 text-[10px] text-cbv2-text-dim flex items-center gap-2 flex-wrap">
          <span>Choose a project here, then continue in chat for stack, goals, and confirmation.</span>
        </div>
      )}
    </div>
  );
}
