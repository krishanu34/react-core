"use client";

import React, { useCallback, useMemo, useState } from "react";
import type { CBv2GenerationStatus } from "@/types/code-builder-v2";
import type {
  LegacyModernizationDraft,
  LegacyModernizationProject,
  LegacyModernizationStartRequest,
} from "@/types/legacy-modernization";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
} from "lucide-react";
import { useLegacyModProjects, useLegacyModCodeContext, useLegacyModSuggestions } from "@/hooks/useLegacyModernizationQueries";

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

interface ModernizationSetupProps {
  draft: LegacyModernizationDraft;
  status: CBv2GenerationStatus;
  summary: Record<string, unknown> | null;
  onDraftChange: (patch: Partial<LegacyModernizationDraft>) => void;
  onStart: (request: LegacyModernizationStartRequest) => void;
  onGenerateSpecs: (
    workspaceRoot: string,
    specTypes: Array<"functional" | "technical">
  ) => Promise<Record<string, unknown> | null>;
  onStartCodeGeneration: (request: {
    project_id?: number;
    workspace_root: string;
    target_stack: string;
    modernization_goal?: string;
    confirmed: boolean;
  }) => void;
  onOpenArtifact: (path: string) => void;
}

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
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        {icon}
        <span className="uppercase tracking-wide">{title}</span>
      </button>
      {open ? <div className="px-4 pb-3">{children}</div> : null}
    </div>
  );
}

export default function ModernizationSetup({
  draft,
  status,
  summary: _summary,
  onDraftChange,
  onStart,
  onGenerateSpecs: _onGenerateSpecs,
  onStartCodeGeneration: _onStartCodeGeneration,
  onOpenArtifact: _onOpenArtifact,
}: ModernizationSetupProps) {
  const { data: projects = [], isLoading: projectsLoading, error: projectsQueryError, refetch: refreshProjects } = useLegacyModProjects();
  const projectsError = projectsQueryError ? (projectsQueryError as Error).message : "";

  const { data: codeContext = null, isLoading: codeContextLoading, error: codeContextQueryError, refetch: refreshCodeContext } = useLegacyModCodeContext(
    (draft.projectId && draft.projectId > 0) ? draft.projectId : null,
  );
  const codeContextError = codeContextQueryError ? (codeContextQueryError as Error).message : "";

  const { data: suggestions = null, isLoading: suggestionsLoading } = useLegacyModSuggestions(
    (draft.projectId && draft.projectId > 0) ? draft.projectId : null,
    Boolean(codeContext?.stored),
    null,
    draft.targetStack,
  );

  const isRunning = status === "running" || status === "connecting";

  const toFilename = useCallback((value: string) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    const parts = trimmed.split(/[/\\]+/g).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : trimmed;
  }, []);

  const selectedProject = useMemo(() => {
    return projects.find((p) => Number(p.project_id) === Number(draft.projectId)) ?? null;
  }, [draft.projectId, projects]);

  const canStart = useMemo(() => {
    if (!draft.targetStack.trim() || isRunning) return false;
    if (!draft.projectId || draft.projectId <= 0) return false;
    if (selectedProject?.modernization_eligible !== true) return false;
    return Boolean(codeContext?.stored);
  }, [codeContext?.stored, draft.projectId, draft.targetStack, isRunning, selectedProject?.modernization_eligible]);

  const handleStart = () => {
    if (!canStart) return;
    onStart({
      project_id: draft.projectId,
      target_stack: draft.targetStack.trim(),
      modernization_goal: draft.modernizationGoal.trim() || undefined,
    });
  };

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden">
      <div className="px-4 py-2.5 border-b border-cbv2-border flex items-center justify-between shrink-0 cbv2-header-gradient">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-cbv2-accent/15 flex items-center justify-center">
            <Settings className="w-4 h-4 text-cbv2-accent" />
          </div>
          <span className="text-[12px] font-semibold">
            Configuration
          </span>
        </div>
        <div className="inline-flex items-center gap-1 rounded-full border border-cbv2-accent/25 bg-cbv2-accent/10 px-2 py-1 text-[10px] text-cbv2-accent">
          <Sparkles className="w-3 h-3" />
          Legacy
        </div>
      </div>

      <div className="flex-1 overflow-y-auto cbv2-scrollbar">
        <Section
          title="Project"
          icon={<FolderKanban className="w-3.5 h-3.5 text-yellow-400" />}
        >
          <div className="rounded-lg border border-cbv2-border bg-cbv2-input/40 px-3 py-2 text-[11px] text-cbv2-text-dim">
            Select a project created in Project Context. Repo upload or GitHub link stays there.
          </div>
          <div className="mt-3 flex gap-2">
            <select
              className="w-full px-3 py-2 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text outline-none focus:border-cbv2-accent"
              value={draft.projectId || 0}
              onChange={(e) => {
                const nextId = Number(e.target.value);
                if (nextId <= 0) {
                  onDraftChange({ projectId: 0 });
                  return;
                }
                const project = projects.find((item) => Number(item.project_id) === nextId);
                if (project?.modernization_eligible !== true) {
                  return;
                }
                onDraftChange({ projectId: nextId });
              }}
              disabled={isRunning || projectsLoading}
            >
              <option value={0}>Select a project...</option>
              {projects.map((project) => (
                <option
                  key={String(project.project_id)}
                  value={Number(project.project_id)}
                  disabled={project.modernization_eligible !== true}
                >
                  {String(project.project_name ?? `Project ${project.project_id}`)} (ID {project.project_id})
                  {` - ${getProjectEligibilityLabel(project)}`}
                </option>
              ))}
            </select>
            <button
              className={[
                "p-2 rounded border transition-colors",
                projectsLoading || isRunning
                  ? "border-cbv2-border bg-cbv2-input/50 text-cbv2-text-dim cursor-not-allowed"
                  : "border-cbv2-border bg-cbv2-input text-cbv2-text hover:border-cbv2-accent/40",
              ].join(" ")}
              onClick={() => void refreshProjects()}
              disabled={projectsLoading || isRunning}
              title="Refresh projects"
            >
              {projectsLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          {projectsError ? (
            <div className="mt-2 text-[11px] text-red-400">{projectsError}</div>
          ) : null}
        </Section>

        <Section
          title="Modernization Settings"
          icon={<Layers className="w-3.5 h-3.5 text-cbv2-accent" />}
        >
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wide text-cbv2-text-dim">
              Target Stack <span className="text-red-400">*</span>
              {draft.targetStack.trim() && <Check className="w-3 h-3 text-green-400" />}
            </span>
            <input
              className="w-full px-3 py-2 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text outline-none focus:border-cbv2-accent transition-colors"
              value={draft.targetStack}
              onChange={(e) => onDraftChange({ targetStack: e.target.value })}
              placeholder="Python with FastAPI, Java with Spring Boot, .NET Web API"
              disabled={isRunning}
            />
          </label>
          {suggestionsLoading && !suggestions ? (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cbv2-text-dim">
              <Loader2 className="w-3 h-3 animate-spin" />
              Generating suggestions from repo...
            </div>
          ) : suggestions?.target_stack_suggestions?.length ? (
            <div className="mt-2">
              {suggestions.detected_source && (
                <div className="text-[10px] text-cbv2-text-dim mb-1.5">
                  Detected: {suggestions.detected_source}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {suggestions.target_stack_suggestions.map((stack) => (
                  <button
                    key={stack}
                    type="button"
                    className={[
                      "px-2 py-1 rounded-full text-[10px] border transition-colors",
                      draft.targetStack === stack
                        ? "border-cbv2-accent bg-cbv2-accent/20 text-cbv2-accent"
                        : "border-cbv2-border bg-cbv2-input/60 text-cbv2-text hover:border-cbv2-accent/40 hover:bg-cbv2-accent/10",
                    ].join(" ")}
                    onClick={() => onDraftChange({ targetStack: stack })}
                    disabled={isRunning}
                  >
                    {stack}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="block mt-3">
            <span className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wide text-cbv2-text-dim">
              Modernization Goal
              <span className="text-[9px] normal-case tracking-normal font-normal">(optional)</span>
            </span>
            <textarea
              className="min-h-[120px] w-full px-3 py-2 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text outline-none focus:border-cbv2-accent resize-y transition-colors"
              value={draft.modernizationGoal}
              onChange={(e) =>
                onDraftChange({ modernizationGoal: e.target.value })
              }
              placeholder="Optional migration constraints, architecture goals, or non-functional requirements."
              disabled={isRunning}
              maxLength={2000}
            />
            <div className="flex justify-end mt-1">
              <span className={`text-[10px] ${draft.modernizationGoal.length > 1800 ? "text-amber-400" : "text-cbv2-text-dim"}`}>
                {draft.modernizationGoal.length}/2000
              </span>
            </div>
          </label>
          {suggestions?.modernization_goal_suggestions?.length ? (
            <div className="mt-2">
              <div className="text-[10px] text-cbv2-text-dim mb-1.5">Suggested goals:</div>
              <div className="flex flex-col gap-1.5">
                {suggestions.modernization_goal_suggestions.map((goal) => (
                  <button
                    key={goal}
                    type="button"
                    className={[
                      "px-2.5 py-1.5 rounded text-[10px] border text-left transition-colors",
                      draft.modernizationGoal === goal
                        ? "border-cbv2-accent bg-cbv2-accent/20 text-cbv2-accent"
                        : "border-cbv2-border bg-cbv2-input/60 text-cbv2-text hover:border-cbv2-accent/40 hover:bg-cbv2-accent/10",
                    ].join(" ")}
                    onClick={() => onDraftChange({ modernizationGoal: goal })}
                    disabled={isRunning}
                  >
                    {goal}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </Section>

        <Section
          title="Project Context"
          icon={<Sparkles className="w-3.5 h-3.5 text-green-400" />}
        >
          {!draft.projectId || draft.projectId <= 0 ? (
            <div className="text-[11px] text-cbv2-text-dim">
              Choose a project to check whether its code context is ready.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-cbv2-border bg-cbv2-input/60 p-3">
                <div className="text-[12px] font-medium text-cbv2-text">
                  {selectedProject?.project_name
                    ? String(selectedProject.project_name)
                    : `Project ${draft.projectId}`}
                </div>
                <div className="mt-1 text-[11px] text-cbv2-text-dim">
                  Project ID {draft.projectId}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px]">
                <div className="text-cbv2-text-dim">
                  {codeContextLoading ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Checking code context...
                    </span>
                  ) : codeContext ? (
                    codeContext.stored ? (
                      <span className="text-green-400">Code context ready</span>
                    ) : (
                      <span className="text-yellow-400">No code context found</span>
                    )
                  ) : (
                    <span>Select project to check code context</span>
                  )}
                </div>
                <button
                  className={[
                    "p-2 rounded border transition-colors",
                    isRunning || codeContextLoading
                      ? "border-cbv2-border bg-cbv2-input/50 text-cbv2-text-dim cursor-not-allowed"
                      : "border-cbv2-border bg-cbv2-input text-cbv2-text hover:border-cbv2-accent/40",
                  ].join(" ")}
                  onClick={() => void refreshCodeContext()}
                  disabled={isRunning || codeContextLoading}
                  title="Refresh code context"
                >
                  {codeContextLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              {codeContextError ? (
                <div className="text-[11px] text-red-400">{codeContextError}</div>
              ) : null}

              {codeContext ? (
                <div className="rounded-lg border border-cbv2-border bg-cbv2-input/60 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-cbv2-text-dim">
                    Indexed Files
                  </div>
                  <div className="mt-2 text-[12px] text-cbv2-text">
                    {typeof codeContext.total_files === "number"
                      ? `${codeContext.total_files} files`
                      : `${codeContext.files.length} files`}
                    {typeof codeContext.total_chunks === "number"
                      ? ` | ${codeContext.total_chunks} chunks`
                      : ""}
                  </div>
                  {codeContext.stored ? (
                    <div className="mt-3 max-h-48 overflow-auto rounded border border-cbv2-border bg-cbv2-sidebar/40 p-2 text-[11px] font-mono text-cbv2-text cbv2-scrollbar">
                      {(codeContext.files ?? []).slice(0, 100).map((filePath) => (
                        <div key={filePath} className="truncate" title={filePath}>
                          {toFilename(filePath)}
                        </div>
                      ))}
                      {(codeContext.files?.length ?? 0) > 100 ? (
                        <div className="mt-1 text-cbv2-text-dim">
                          ...and {codeContext.files.length - 100} more
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-cbv2-text-dim">
                      Upload a repo ZIP or provide a GitHub link from Project Context for this project, then refresh.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </Section>
      </div>

      <div className="px-4 py-3 border-t border-cbv2-border shrink-0">
        <button
          className={[
            "w-full py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-2",
            canStart
              ? "bg-cbv2-accent text-white hover:bg-cbv2-accent/80"
              : "bg-cbv2-input text-cbv2-text-dim border border-cbv2-border",
          ].join(" ")}
          onClick={handleStart}
          disabled={!canStart}
        >
          {isRunning ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          Start Reverse Engineering
        </button>
        {!draft.projectId || draft.projectId <= 0 ? (
          <div className="mt-2 text-[10px] text-cbv2-text-dim">
            Select a project to continue.
          </div>
        ) : !codeContext?.stored ? (
          <div className="mt-2 text-[10px] text-cbv2-text-dim">
            Code context must be ready before modernization can start.
          </div>
        ) : !draft.targetStack.trim() ? (
          <div className="mt-2 text-[10px] text-cbv2-text-dim">
            Enter a target stack to continue.
          </div>
        ) : (
          <div className="mt-2 text-[10px] text-cbv2-text-dim">
            Reverse engineering will start in this workspace and code generation will follow automatically.
          </div>
        )}
      </div>
    </div>
  );
}
