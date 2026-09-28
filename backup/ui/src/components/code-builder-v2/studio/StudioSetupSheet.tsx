"use client";

/**
 * StudioSetupSheet — the unified Code Builder onboarding flow that
 * lives INSIDE the studio shell. It replaces the standalone
 * /code-builder/new wizard so the user never leaves the studio.
 *
 * Flow:
 *   1. Project        — pick / create
 *   2. Stories & Docs — optional, can be skipped
 *   3. Goal + AI      — analyse with /api/v3/understand
 *   4. Review         — answer clarifications, then Generate
 *
 * On Generate it invokes `onComplete(description, projectName, context)`
 * which the parent page wires into `agent.startGeneration(...)` directly
 * (no sessionStorage, no navigation).
 */

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileText,
  FolderTree,
  Layers,
  Loader2,
  Plus,
  Rocket,
  Search,
  SkipForward,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useDbProjects, type DbProject } from "@/hooks/useDbProjects";
import {
  useCBv2ApprovedArtifacts,
  useProjectDocumentArtifacts,
} from "@/hooks/useCodeBuilderQueries";
import type { CBv2ArtifactItem } from "@/hooks/useCodeBuilderQueries";
import { authFetch } from "@/lib/auth";
import type {
  CBv2Artifact,
  CBv2ChatContext,
  CBv2PipelineType,
} from "@/types/code-builder-v2";

const CB_API_BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

interface UnderstandResponse {
  tech_stack: Record<string, string[]>;
  tech_stack_sources: string[];
  architecture: string;
  modules: Array<{ name: string; purpose?: string }>;
  proposed_structure: string[];
  assumptions: string[];
  risks: string[];
  clarification_questions: Array<{ id: string; question: string }>;
  ready: boolean;
  llm_error: string | null;
}

type WizardStep = "project" | "context" | "analyse" | "approve";

const STEP_ORDER: WizardStep[] = ["project", "context", "analyse", "approve"];
const STEP_LABEL: Record<WizardStep, string> = {
  project: "Project",
  context: "Stories & Documents",
  analyse: "Goal & AI Analysis",
  approve: "Review & Generate",
};

export interface StudioSetupSheetProps {
  /** Hide the close button — used when the studio has no project yet so the user can't dismiss into an empty shell. */
  dismissible?: boolean;
  /** Optional pre-fill for the prompt (e.g. when reopened from chat). */
  initialPrompt?: string;
  /** Optional project to start the wizard at (skips step 1). */
  initialProject?: DbProject | null;
  onClose?: () => void;
  onComplete: (
    description: string,
    projectName: string,
    context: CBv2ChatContext,
  ) => void;
}

export default function StudioSetupSheet({
  dismissible = true,
  initialPrompt = "",
  initialProject = null,
  onClose,
  onComplete,
}: StudioSetupSheetProps) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(initialProject ? "context" : "project");
  const [project, setProject] = useState<DbProject | null>(initialProject);
  const [pipelineType, setPipelineType] = useState<CBv2PipelineType>("greenfield");

  const [selectedStoryIds, setSelectedStoryIds] = useState<number[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<number[]>([]);
  const [onlyStarred, setOnlyStarred] = useState(true);

  const [description, setDescription] = useState(initialPrompt);
  const [analysing, setAnalysing] = useState(false);
  const [analysis, setAnalysis] = useState<UnderstandResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({});

  const approvedArtifacts = useCBv2ApprovedArtifacts(project?.id ?? null);
  const documentArtifacts = useProjectDocumentArtifacts(project?.id ?? null);

  // Normalise artifact items from the hooks (which use CBv2ArtifactItem)
  // into the UI-facing `CBv2Artifact` shape so nullable title/description
  // fields don't cause type mismatches downstream.
  const normalizeArtifact = (a: CBv2ArtifactItem): CBv2Artifact => ({
    id: a.id,
    project_id: (a as any).project_id,
    artifact_type: a.artifact_type,
    artifact_id: (a as any).artifact_id,
    parent_artifact_id: (a as any).parent_artifact_id ?? null,
    title: a.title ?? "",
    description: a.description ?? undefined,
    content: (a as any).content ?? {},
    version: a.version ?? undefined,
    created_at: a.created_at ?? undefined,
    approval_status: a.approval_status ?? undefined,
    run_is_selected: a.run_is_selected,
    run_review_flag: a.run_review_flag,
  });

  const storyArtifacts = useMemo(() => {
    const all = (approvedArtifacts.data ?? []) as CBv2ArtifactItem[];
    const filtered = all.filter((a) =>
      ["epic", "feature", "user_story", "story"].includes(a.artifact_type),
    );
    return filtered.map(normalizeArtifact);
  }, [approvedArtifacts.data]);

  const selectedStories = useMemo(
    () => storyArtifacts.filter((s) => selectedStoryIds.includes(s.id)),
    [storyArtifacts, selectedStoryIds],
  );

  const documentsList = useMemo(() => {
    const all = (documentArtifacts.data ?? []) as CBv2ArtifactItem[];
    return all.map(normalizeArtifact);
  }, [documentArtifacts.data]);

  const selectedDocs = useMemo(
    () => documentsList.filter((d) => selectedDocIds.includes(d.id)),
    [documentsList, selectedDocIds],
  );

  const goNext = () => {
    const i = STEP_ORDER.indexOf(step);
    if (i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]);
  };
  const goPrev = () => {
    const i = STEP_ORDER.indexOf(step);
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  };

  const canAdvance: Record<WizardStep, boolean> = {
    project: !!project,
    context: !!project,
    analyse: !!analysis && !analysis.llm_error,
    approve:
      !!analysis &&
      (analysis.clarification_questions ?? []).every(
        (q) => (clarifyAnswers[q.id] ?? "").trim().length > 0,
      ),
  };

  const runAnalysis = async () => {
    if (!project || !description.trim()) return;
    setAnalysing(true);
    setAnalysisError(null);
    try {
      const res = await authFetch(`${CB_API_BASE}/v3/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          project_id: project.id,
          project_name: project.name,
          pipeline_type: pipelineType,
          stories: selectedStories.map(serialiseArtifact),
          documents: selectedDocs.map(serialiseArtifact),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data: UnderstandResponse = await res.json();
      setAnalysis(data);
      setClarifyAnswers((prev) => {
        const next = { ...prev };
        for (const q of data.clarification_questions ?? []) {
          if (next[q.id] == null) next[q.id] = "";
        }
        return next;
      });
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalysing(false);
    }
  };

  /** Bypass AI analysis and jump straight to generation with the raw description. */
  const launchDirect = () => {
    if (!project || !description.trim()) return;
    const ctx: CBv2ChatContext = {
      project_id: project.id,
      project_name: project.name,
      pipeline_type: pipelineType,
      selected_story_ids: selectedStoryIds,
      selected_stories: selectedStories,
      selected_document_ids: selectedDocIds,
      selected_documents: selectedDocs,
      selected_doc_types: [],
    };
    onComplete(description.trim(), project.name, ctx);
  };

  const launchGeneration = () => {
    if (!project || !analysis) return;
    const enrichedDescription = buildEnrichedDescription(
      description,
      analysis,
      clarifyAnswers,
    );
    const ctx: CBv2ChatContext = {
      project_id: project.id,
      project_name: project.name,
      pipeline_type: pipelineType,
      selected_story_ids: selectedStoryIds,
      selected_stories: selectedStories,
      selected_document_ids: selectedDocIds,
      selected_documents: selectedDocs,
      selected_doc_types: [],
    };
    onComplete(enrichedDescription, project.name, ctx);
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-950 text-slate-100">
      <Header
        dismissible={dismissible}
        projectName={project?.name ?? null}
        onClose={onClose}
      />
      <Stepper
        current={step}
        completed={{
          project: !!project,
          context: !!project,
          analyse: !!analysis,
          approve: false,
        }}
        onJump={(s) => {
          // Allow jumping back to completed steps freely; forward jumps
          // require the gating predicate to pass.
          const targetIdx = STEP_ORDER.indexOf(s);
          const currIdx = STEP_ORDER.indexOf(step);
          if (targetIdx <= currIdx) setStep(s);
          else if (s === "context" && project) setStep(s);
          else if (s === "analyse" && project) setStep(s);
          else if (s === "approve" && analysis) setStep(s);
        }}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 pb-32">
          {step === "project" && (
            <ProjectStep
              selected={project}
              onSelect={(p) => setProject(p)}
              onCreateNew={() => router.push("/projects/new")}
              pipelineType={pipelineType}
              onPipelineTypeChange={setPipelineType}
            />
          )}

          {step === "context" && project && (
            <ContextStep
              project={project}
              stories={storyArtifacts}
              storiesLoading={approvedArtifacts.isLoading}
                  documents={documentsList}
              documentsLoading={documentArtifacts.isLoading}
              selectedStoryIds={selectedStoryIds}
              selectedDocIds={selectedDocIds}
              onToggleStory={(id) =>
                setSelectedStoryIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                )
              }
              onToggleDoc={(id) =>
                setSelectedDocIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                )
              }
              onToggleAllStories={(ids) => setSelectedStoryIds(ids)}
              onToggleAllDocs={(ids) => setSelectedDocIds(ids)}
              onlyStarred={onlyStarred}
              onToggleOnlyStarred={() => setOnlyStarred((v) => !v)}
            />
          )}

          {step === "analyse" && project && (
            <AnalyseStep
              project={project}
              description={description}
              onDescriptionChange={setDescription}
              pipelineType={pipelineType}
              onPipelineTypeChange={setPipelineType}
              selectedStories={selectedStories}
              selectedDocs={selectedDocs}
              analysis={analysis}
              analysing={analysing}
              analysisError={analysisError}
              onAnalyse={runAnalysis}
              onSkipToChat={launchDirect}
            />
          )}

          {step === "approve" && project && analysis && (
            <ApproveStep
              analysis={analysis}
              clarifyAnswers={clarifyAnswers}
              onAnswerChange={(id, val) =>
                setClarifyAnswers((prev) => ({ ...prev, [id]: val }))
              }
            />
          )}
        </div>
      </main>

      <Footer
        step={step}
        canAdvance={canAdvance[step]}
        canSkipToChat={step === "analyse" && !!project && description.trim().length >= 5}
        onBack={goPrev}
        onNext={goNext}
        onSkipToChat={launchDirect}
        onFinish={launchGeneration}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Header / Stepper / Footer                                            */
/* ──────────────────────────────────────────────────────────────────── */

function Header({
  dismissible,
  projectName,
  onClose,
}: {
  dismissible: boolean;
  projectName: string | null;
  onClose?: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-indigo-400" />
          <h1 className="text-sm font-semibold tracking-tight">
            Code Builder · Setup
          </h1>
          {projectName && (
            <span className="rounded-full border border-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
              {projectName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-slate-500 sm:block">
            Guided generation · review before you build
          </p>
          {dismissible && onClose && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              aria-label="Close setup"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function Stepper({
  current,
  completed,
  onJump,
}: {
  current: WizardStep;
  completed: Record<WizardStep, boolean>;
  onJump: (s: WizardStep) => void;
}) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <div className="border-b border-slate-800/80">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-4">
        {STEP_ORDER.map((s, i) => {
          const isDone = i < idx;
          const isCurrent = i === idx;
          return (
            <React.Fragment key={s}>
              <button
                onClick={() => onJump(s)}
                disabled={!isDone && !isCurrent && !completed[s]}
                className={[
                  "flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors",
                  isCurrent
                    ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                    : isDone
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                      : "border-slate-700 text-slate-400 disabled:opacity-50",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                    isCurrent
                      ? "bg-indigo-500 text-white"
                      : isDone
                        ? "bg-emerald-500/30 text-emerald-200"
                        : "bg-slate-800 text-slate-400",
                  ].join(" ")}
                >
                  {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className="font-medium">{STEP_LABEL[s]}</span>
              </button>
              {i < STEP_ORDER.length - 1 && (
                <ChevronRight className="h-3.5 w-3.5 text-slate-700" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function Footer({
  step,
  canAdvance,
  canSkipToChat,
  onBack,
  onNext,
  onSkipToChat,
  onFinish,
}: {
  step: WizardStep;
  canAdvance: boolean;
  canSkipToChat: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkipToChat: () => void;
  onFinish: () => void;
}) {
  const isFirst = step === STEP_ORDER[0];
  const isLast = step === STEP_ORDER[STEP_ORDER.length - 1];
  return (
    <div className="border-t border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <button
          onClick={onBack}
          disabled={isFirst}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>

        <div className="flex items-center gap-2">
          {step === "analyse" && (
            <button
              onClick={onSkipToChat}
              disabled={!canSkipToChat}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              title="Skip AI analysis and start generation directly from your prompt"
            >
              <SkipForward className="h-3.5 w-3.5" /> Skip & generate
            </button>
          )}
          {isLast ? (
            <button
              onClick={onFinish}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Rocket className="h-3.5 w-3.5" /> Generate Code
            </button>
          ) : (
            <button
              onClick={onNext}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Step 1 — Project picker                                              */
/* ──────────────────────────────────────────────────────────────────── */

function ProjectStep({
  selected,
  onSelect,
  onCreateNew,
  pipelineType,
  onPipelineTypeChange,
}: {
  selected: DbProject | null;
  onSelect: (p: DbProject) => void;
  onCreateNew: () => void;
  pipelineType: CBv2PipelineType;
  onPipelineTypeChange: (t: CBv2PipelineType) => void;
}) {
  const { projects, loading } = useDbProjects();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const list = (projects ?? []).filter((p) => !p.archived);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [projects, query]);

  return (
    <section className="space-y-6 py-8">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Pick or create a project</h2>
        <p className="text-sm text-slate-400">
          Code Builder generates against a project so all artefacts, history,
          and model settings stay together.
        </p>
      </header>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="w-full rounded-md border border-slate-800 bg-slate-900/60 py-2 pl-9 pr-3 text-sm placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <button
          onClick={onCreateNew}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium hover:border-indigo-500 hover:text-indigo-300"
        >
          <Plus className="h-3.5 w-3.5" /> Create new project
        </button>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/40">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading projects…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            No projects match. Create a new one to continue.
          </div>
        ) : (
          <ul className="max-h-[420px] divide-y divide-slate-800 overflow-y-auto">
            {filtered.map((p) => {
              const isSel = selected?.id === p.id;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p)}
                    className={[
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                      isSel ? "bg-indigo-500/10" : "hover:bg-slate-800/60",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border",
                        isSel
                          ? "border-indigo-400 bg-indigo-500"
                          : "border-slate-600",
                      ].join(" ")}
                    >
                      {isSel && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                        {p.has_code_context && (
                          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                            code KB
                          </span>
                        )}
                        {p.has_doc_context && (
                          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                            docs KB
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                          {p.description}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Generation mode
          </h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ModeOption
              active={pipelineType === "greenfield"}
              label="Greenfield"
              desc="Start a brand new codebase from the selected context."
              onClick={() => onPipelineTypeChange("greenfield")}
            />
            <ModeOption
              active={pipelineType === "brownfield"}
              label="Brownfield"
              desc="Extend or modify the existing project workspace."
              onClick={() => onPipelineTypeChange("brownfield")}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function ModeOption({
  active,
  label,
  desc,
  onClick,
}: {
  active: boolean;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-indigo-500/60 bg-indigo-500/10"
          : "border-slate-800 bg-slate-900/40 hover:border-slate-700",
      ].join(" ")}
    >
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Step 2 — Context                                                      */
/* ──────────────────────────────────────────────────────────────────── */

function ContextStep({
  project,
  stories,
  storiesLoading,
  documents,
  documentsLoading,
  selectedStoryIds,
  selectedDocIds,
  onToggleStory,
  onToggleDoc,
  onToggleAllStories,
  onToggleAllDocs,
  onlyStarred,
  onToggleOnlyStarred,
}: {
  project: DbProject;
  stories: CBv2Artifact[];
  storiesLoading: boolean;
  documents: CBv2Artifact[];
  documentsLoading: boolean;
  selectedStoryIds: number[];
  selectedDocIds: number[];
  onToggleStory: (id: number) => void;
  onToggleDoc: (id: number) => void;
  onToggleAllStories: (ids: number[]) => void;
  onToggleAllDocs: (ids: number[]) => void;
  onlyStarred: boolean;
  onToggleOnlyStarred: () => void;
}) {
  const grouped = useMemo(() => groupStories(stories), [stories]);
  const allStoryIds = useMemo(() => stories.map((s) => s.id), [stories]);
  const allDocIds = useMemo(() => documents.map((d) => d.id), [documents]);

  return (
    <section className="space-y-6 py-8">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">
          Select context from <span className="text-indigo-300">{project.name}</span>{" "}
          <span className="ml-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
            optional
          </span>
        </h2>
        <p className="text-sm text-slate-400">
          Approved User Stories and Documents help the AI ground its
          generation in your project's real intent. Skip this step to go
          straight to a free-form prompt.
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button
            onClick={onToggleOnlyStarred}
            className={[
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors",
              onlyStarred
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-slate-700 text-slate-400 hover:border-slate-600",
            ].join(" ")}
          >
            <Star
              className={[
                "h-3 w-3",
                onlyStarred ? "fill-amber-400 text-amber-400" : "",
              ].join(" ")}
            />
            Approved &amp; star-marked
          </button>
          <span className="text-slate-600">·</span>
          <span className="text-slate-500">
            {stories.length} stories · {documents.length} documents
          </span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40">
          <PanelHeader
            icon={<Layers className="h-3.5 w-3.5" />}
            title="User Stories"
            count={`${selectedStoryIds.length}/${stories.length}`}
            onSelectAll={() =>
              onToggleAllStories(
                selectedStoryIds.length === stories.length ? [] : allStoryIds,
              )
            }
            allSelected={selectedStoryIds.length === stories.length && stories.length > 0}
          />
          {storiesLoading ? (
            <Loading />
          ) : stories.length === 0 ? (
            <Empty>No approved stories for this project yet.</Empty>
          ) : (
            <div className="max-h-[460px] overflow-y-auto divide-y divide-slate-800/80">
              {grouped.map((g) => (
                <div key={g.id} className="px-2 py-1.5">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {g.name}{" "}
                    <span className="text-slate-600">({g.items.length})</span>
                  </p>
                  <ul className="space-y-0.5">
                    {g.items.map((s) => {
                      const isSel = selectedStoryIds.includes(s.id);
                      return (
                        <li key={s.id}>
                          <button
                            onClick={() => onToggleStory(s.id)}
                            className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-800/60"
                          >
                            <span
                              className={[
                                "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                                isSel
                                  ? "border-indigo-400 bg-indigo-500"
                                  : "border-slate-600",
                              ].join(" ")}
                            >
                              {isSel && <CheckCircle2 className="h-3 w-3 text-white" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-slate-200">
                                {s.title}
                              </span>
                              {s.description && (
                                <span className="block truncate text-[11px] text-slate-500">
                                  {s.description}
                                </span>
                              )}
                            </span>
                            <span
                              className={[
                                "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                                TYPE_BADGE[s.artifact_type] ??
                                  "bg-slate-800 text-slate-400",
                              ].join(" ")}
                            >
                              {s.artifact_type.replace("_", " ")}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40">
          <PanelHeader
            icon={<FileText className="h-3.5 w-3.5" />}
            title="Documents"
            count={`${selectedDocIds.length}/${documents.length}`}
            onSelectAll={() =>
              onToggleAllDocs(
                selectedDocIds.length === documents.length ? [] : allDocIds,
              )
            }
            allSelected={selectedDocIds.length === documents.length && documents.length > 0}
          />
          {documentsLoading ? (
            <Loading />
          ) : documents.length === 0 ? (
            <Empty>No documents available for this project yet.</Empty>
          ) : (
            <ul className="max-h-[460px] divide-y divide-slate-800/80 overflow-y-auto">
              {documents.map((d) => {
                const isSel = selectedDocIds.includes(d.id);
                return (
                  <li key={d.id}>
                    <button
                      onClick={() => onToggleDoc(d.id)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-800/60"
                    >
                      <span
                        className={[
                          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                          isSel
                            ? "border-indigo-400 bg-indigo-500"
                            : "border-slate-600",
                        ].join(" ")}
                      >
                        {isSel && <CheckCircle2 className="h-3 w-3 text-white" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-slate-200">
                          {d.title}
                        </span>
                        {d.description && (
                          <span className="block truncate text-[11px] text-slate-500">
                            {d.description}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[9px] font-medium text-slate-400">
                        {d.artifact_type.replace("_document", "").toUpperCase()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function PanelHeader({
  icon,
  title,
  count,
  onSelectAll,
  allSelected,
}: {
  icon: React.ReactNode;
  title: string;
  count: string;
  onSelectAll: () => void;
  allSelected: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
        {icon} {title}
        <span className="text-slate-500">{count}</span>
      </div>
      <button
        onClick={onSelectAll}
        className="text-[11px] text-indigo-300 hover:text-indigo-200"
      >
        {allSelected ? "Clear" : "Select all"}
      </button>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-xs text-slate-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-xs text-slate-500">{children}</div>;
}

/* ──────────────────────────────────────────────────────────────────── */
/* Step 3 — Analyse                                                      */
/* ──────────────────────────────────────────────────────────────────── */

function AnalyseStep({
  project,
  description,
  onDescriptionChange,
  pipelineType,
  selectedStories,
  selectedDocs,
  analysis,
  analysing,
  analysisError,
  onAnalyse,
  onSkipToChat,
}: {
  project: DbProject;
  description: string;
  onDescriptionChange: (s: string) => void;
  pipelineType: CBv2PipelineType;
  onPipelineTypeChange: (t: CBv2PipelineType) => void;
  selectedStories: CBv2Artifact[];
  selectedDocs: CBv2Artifact[];
  analysis: UnderstandResponse | null;
  analysing: boolean;
  analysisError: string | null;
  onAnalyse: () => void;
  onSkipToChat: () => void;
}) {
  return (
    <section className="space-y-6 py-8">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Describe what you want to build</h2>
        <p className="text-sm text-slate-400">
          The AI will read your goal alongside the selected stories and
          documents, then propose an architecture and tech stack for you to
          approve. Or click <strong className="text-slate-300">Skip &amp; generate</strong>{" "}
          to drop straight into the chat with your prompt.
        </p>
      </header>

      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={5}
          placeholder="e.g. Build a multi-tenant REST API for managing customer onboarding workflows. Honour the LLD for the auth subsystem and reuse the existing PostgreSQL schema."
          className="w-full resize-none rounded-md border border-slate-800 bg-slate-950/60 p-3 text-sm placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="rounded bg-slate-800 px-1.5 py-0.5">
              Project: {project.name}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5">
              Mode: {pipelineType}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5">
              {selectedStories.length} stories · {selectedDocs.length} documents
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onSkipToChat}
              disabled={description.trim().length < 5}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SkipForward className="h-3.5 w-3.5" /> Skip &amp; generate
            </button>
            <button
              onClick={onAnalyse}
              disabled={analysing || description.trim().length < 5}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {analysing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Brain className="h-3.5 w-3.5" />
              )}
              {analysis ? "Re-analyse" : "Analyse with AI"}
            </button>
          </div>
        </div>
      </div>

      {analysisError && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          Failed to analyse: {analysisError}
        </div>
      )}

      {analysis && <UnderstandingSummary data={analysis} />}
    </section>
  );
}

function UnderstandingSummary({ data }: { data: UnderstandResponse }) {
  return (
    <div className="space-y-4 rounded-lg border border-indigo-500/30 bg-indigo-500/[0.04] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-indigo-300" />
        Project Understanding Summary
      </div>

      {data.llm_error && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          AI analysis unavailable ({data.llm_error}). Showing deterministic
          inference only.
        </p>
      )}

      {data.architecture && (
        <SummaryRow label="Identified architecture">
          <p className="text-sm text-slate-200">{data.architecture}</p>
        </SummaryRow>
      )}

      {Object.keys(data.tech_stack).length > 0 && (
        <SummaryRow label="Suggested tech stack">
          <div className="space-y-1">
            {Object.entries(data.tech_stack).map(([layer, techs]) => (
              <div key={layer} className="text-xs">
                <span className="font-semibold text-slate-300">
                  {layer.toUpperCase()}:
                </span>{" "}
                <span className="text-slate-400">{techs.join(", ")}</span>
              </div>
            ))}
            {data.tech_stack_sources.length > 0 && (
              <p className="pt-1 text-[10px] text-slate-500">
                Inferred from: {data.tech_stack_sources.join(", ")}
              </p>
            )}
          </div>
        </SummaryRow>
      )}

      {data.modules.length > 0 && (
        <SummaryRow label="Proposed modules / services">
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {data.modules.map((m, i) => (
              <li
                key={i}
                className="rounded border border-slate-800 bg-slate-900/60 px-2.5 py-1.5"
              >
                <p className="text-xs font-medium text-slate-200">{m.name}</p>
                {m.purpose && (
                  <p className="text-[11px] text-slate-500">{m.purpose}</p>
                )}
              </li>
            ))}
          </ul>
        </SummaryRow>
      )}

      {data.proposed_structure.length > 0 && (
        <SummaryRow label="Estimated project structure">
          <ul className="rounded border border-slate-800 bg-slate-900/60 p-2 font-mono text-[11px] text-slate-400">
            {data.proposed_structure.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <FolderTree className="h-3 w-3 text-slate-600" /> {p}
              </li>
            ))}
          </ul>
        </SummaryRow>
      )}

      {data.assumptions.length > 0 && (
        <SummaryRow label="Key assumptions">
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {data.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </SummaryRow>
      )}

      {data.risks.length > 0 && (
        <SummaryRow label="Risks to watch">
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-300/80">
            {data.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </SummaryRow>
      )}

      {data.clarification_questions.length > 0 ? (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {data.clarification_questions.length} clarification question
          {data.clarification_questions.length === 1 ? "" : "s"} on the next
          step before code generation can start.
        </p>
      ) : (
        <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          All mandatory information is covered. You can proceed to the final
          review step.
        </p>
      )}
    </div>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      {children}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Step 4 — Approve                                                      */
/* ──────────────────────────────────────────────────────────────────── */

function ApproveStep({
  analysis,
  clarifyAnswers,
  onAnswerChange,
}: {
  analysis: UnderstandResponse;
  clarifyAnswers: Record<string, string>;
  onAnswerChange: (id: string, val: string) => void;
}) {
  const questions = analysis.clarification_questions ?? [];
  return (
    <section className="space-y-6 py-8">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Final review &amp; clarifications</h2>
        <p className="text-sm text-slate-400">
          {questions.length > 0
            ? "Answer the mandatory questions below so the generator has everything it needs. Once complete, click Generate Code."
            : "Everything looks good. Click Generate Code to start the pipeline — you'll land in the studio and see live progress."}
        </p>
      </header>

      <UnderstandingSummary data={analysis} />

      {questions.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-5 space-y-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <Sparkles className="h-4 w-4" /> Missing information
          </h3>
          {questions.map((q) => (
            <div key={q.id} className="space-y-1.5">
              <label
                htmlFor={`q-${q.id}`}
                className="block text-xs font-medium text-amber-100"
              >
                {q.question}
              </label>
              <input
                id={`q-${q.id}`}
                value={clarifyAnswers[q.id] ?? ""}
                onChange={(e) => onAnswerChange(q.id, e.target.value)}
                placeholder="Your answer…"
                className="w-full rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-amber-400 focus:outline-none"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Helpers                                                              */
/* ──────────────────────────────────────────────────────────────────── */

const TYPE_BADGE: Record<string, string> = {
  epic: "bg-purple-500/20 text-purple-300",
  feature: "bg-blue-500/20 text-blue-300",
  user_story: "bg-emerald-500/20 text-emerald-300",
  story: "bg-emerald-500/20 text-emerald-300",
};

interface StoryGroup {
  id: string;
  name: string;
  items: CBv2Artifact[];
}

function groupStories(stories: CBv2Artifact[]): StoryGroup[] {
  if (stories.length === 0) return [];
  const epics = stories.filter((s) => s.artifact_type === "epic");
  const features = stories.filter((s) => s.artifact_type === "feature");
  const userStories = stories.filter(
    (s) => s.artifact_type === "user_story" || s.artifact_type === "story",
  );

  const out: StoryGroup[] = [];
  if (epics.length) out.push({ id: "epics", name: "Epics", items: epics });
  if (features.length)
    out.push({ id: "features", name: "Features", items: features });

  const featureNameById = new Map<string, string>();
  for (const f of features) {
    if (f.artifact_id) featureNameById.set(f.artifact_id, f.title);
  }

  const byFeature = new Map<string, CBv2Artifact[]>();
  for (const s of userStories) {
    const content = (s.content ?? {}) as Record<string, unknown>;
    const fid = (content.feature_id as string) || "unassigned";
    if (!byFeature.has(fid)) byFeature.set(fid, []);
    byFeature.get(fid)!.push(s);
  }
  for (const [fid, items] of byFeature) {
    out.push({
      id: `f-${fid}`,
      name:
        fid === "unassigned"
          ? "Other Stories"
          : (featureNameById.get(fid) ?? fid),
      items,
    });
  }
  return out;
}

function serialiseArtifact(
  a: CBv2Artifact | CBv2ArtifactItem,
): Record<string, unknown> {
  const title = (a as any).title ?? "";
  const description = (a as any).description ?? "";
  const content = (a as any).content ?? {};
  return {
    id: a.id,
    type: (a as any).artifact_type ?? "",
    title,
    description,
    content,
  };
}

function buildEnrichedDescription(
  base: string,
  analysis: UnderstandResponse,
  answers: Record<string, string>,
): string {
  const parts: string[] = [base.trim()];

  const answeredEntries = (analysis.clarification_questions ?? [])
    .map((q) => {
      const v = (answers[q.id] ?? "").trim();
      return v ? `- ${q.question}\n  Answer: ${v}` : null;
    })
    .filter(Boolean) as string[];
  if (answeredEntries.length > 0) {
    parts.push(
      "\n## Mandatory clarifications (answered in setup)\n" +
        answeredEntries.join("\n"),
    );
  }

  if (Object.keys(analysis.tech_stack).length > 0) {
    const stackLines = Object.entries(analysis.tech_stack)
      .map(([k, v]) => `- ${k.toUpperCase()}: ${v.join(", ")}`)
      .join("\n");
    parts.push(`\n## Approved tech stack\n${stackLines}`);
  }

  if (analysis.architecture) {
    parts.push(`\n## Approved architecture\n${analysis.architecture}`);
  }

  return parts.join("\n");
}
