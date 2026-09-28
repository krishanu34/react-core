"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Play,
  StopCircle,
  Sparkles,
  FolderPlus,
  Loader2,
  ChevronDown,
  ChevronUp,
  FolderArchive,
  FileUp,
  X,
  Download,
  Package,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useCodeBuilderStore";
import {
  startPipeline,
  createProject,
  uploadFile,
  uploadZip,
  connectPipelineWs,
  downloadPipelineOutput,
  extractOutputToProject,
} from "@/lib/code-builder-api";
import { useCBProjects, usePipelineRuns, usePipelineRunStatus } from "@/hooks/useCodeBuilderQueries";
import queryKeys from "@/lib/query-keys";
import ModeSelector from "@/components/code-builder/ModeSelector";
import type { PipelineMode, HitlGate, PipelineHistoryItem } from "@/types/code-builder";

/* modes that allow choosing an existing project */
const EXISTING_PROJECT_MODES: PipelineMode[] = ["microservice", "code_intel", "hybrid", "brownfield", "hotfix", "migration"];

/* modes that support browsing existing pipeline outputs as base */
const REUSE_PIPELINE_MODES: PipelineMode[] = ["hybrid", "microservice"];

/* ── Mode-specific placeholders ────────────────────────── */
const PLACEHOLDERS: Record<PipelineMode, string> = {
  greenfield:
    "Describe the application you want to build… e.g., 'Build a REST API for a task manager with user auth, CRUD tasks, and PostgreSQL'",
  brownfield:
    "Describe the improvements for the existing codebase… e.g., 'Refactor the auth module to use JWT tokens and add rate limiting'",
  hybrid:
    "Describe the hybrid development plan… e.g., 'Modernize the legacy payment service while adding a new notification system'",
  hotfix:
    "Describe the bug to fix… e.g., 'Users get 500 error when submitting the checkout form with coupon codes'",
  migration:
    "Describe the migration plan… e.g., 'Migrate the Flask API to FastAPI, keeping all endpoints and adding async support'",
  code_intel:
    "Describe what to analyze… e.g., 'Generate a full code intelligence report on the backend service with metrics'",
  microservice:
    "Describe the microservice architecture… e.g., 'Design a microservice system with user-service, order-service, and API gateway'",
};

/* modes that require/support zip upload */
const ZIP_MODES: PipelineMode[] = ["brownfield", "hybrid", "hotfix", "migration", "code_intel", "microservice"];

export default function AICodeBuilderPanel() {
  const {
    pipelineMode,
    currentProject,
    setCurrentProject,
    setCurrentRun,
    updateCurrentRun,
    currentRun,
    isBuilderExpanded,
    toggleBuilderExpanded,
    isPipelineRunning,
    setIsPipelineRunning,
    zipAttachment,
    setZipAttachment,
    addPendingGate,
    clearGates,
    setActiveSidebarTab,
    setOutputRunId,
    addRunHistory,
    wsConnected,
    setWsConnected,
  } = useStore();

  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [projectName, setProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isActive = currentRun?.status === "running";
  const isCompleted = currentRun?.status === "completed";
  const needsZip = ZIP_MODES.includes(pipelineMode);
  const allowExistingProject = EXISTING_PROJECT_MODES.includes(pipelineMode);
  const allowPipelineReuse = REUSE_PIPELINE_MODES.includes(pipelineMode);

  /* ── Existing project selection state ──────────────── */
  const projectsQuery = useCBProjects(allowExistingProject && isBuilderExpanded);
  const existingProjects = projectsQuery.data ?? [];
  const loadingProjects = projectsQuery.isLoading;
  const [selectedExistingProject, setSelectedExistingProject] = useState<string>("");
  const [useExistingProject, setUseExistingProject] = useState(false);

  /* ── Brownfield/pipeline reuse for hybrid ──────────── */
  const runsQuery = usePipelineRuns();
  const pipelineHistory = useMemo(() =>
    (runsQuery.data ?? []).filter((p: any) => p.status === "completed"),
    [runsQuery.data],
  );
  const [selectedReusePipeline, setSelectedReusePipeline] = useState<string>("");
  const [showPipelineReuse, setShowPipelineReuse] = useState(false);

  /* ── React Query polling fallback for run status ──── */
  const statusQuery = usePipelineRunStatus(
    isPipelineRunning && currentRun?.run_id ? currentRun.run_id : null,
    { wsConnected },
  );

  useEffect(() => {
    const data = statusQuery.data;
    if (!data) return;

    const store = useStore.getState();

    // Sync status to store (complements WebSocket)
    store.updateCurrentRun({
      status: data.status,
      steps: data.steps,
      progress: data.progress,
      output_dir: data.output_dir,
    });

    // Handle pending HITL gate from polling
    const pending = (data as any).pending_gate;
    if (pending?.status === "pending") {
      const gates = store.pendingGates;
      if (!gates.find((g) => g.gate_id === pending.gate_id)) {
        store.addPendingGate({
          gate_id: pending.gate_id,
          type: pending.type ?? "hitl",
          label: pending.label,
          detail: pending.detail ?? "",
          report_file: pending.report_file,
          status: "pending",
          created_at: pending.created_at ?? new Date().toISOString(),
        });
      }
    }

    // Handle completion from polling (if WebSocket missed it)
    if ((data.status === "completed" || data.status === "failed") && store.isPipelineRunning) {
      store.setIsPipelineRunning(false);
      qc.invalidateQueries({ queryKey: ["cb-runs"] });
      if (data.status === "completed") {
        store.addRunHistory(data as any);
        store.setOutputRunId(data.run_id);
        store.setActiveSidebarTab("output");
      }
    }
  }, [statusQuery.data, qc]);

  /* Reset selection when pipeline mode changes */
  useEffect(() => {
    setUseExistingProject(false);
    setSelectedExistingProject("");
    setSelectedReusePipeline("");
    setShowPipelineReuse(false);
  }, [pipelineMode]);

  /* handle file pick for zip */
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>, type: "file" | "zip") => {
    const f = e.target.files?.[0];
    if (f) setZipAttachment({ file: f, type });
    e.target.value = "";
  };

  /* run pipeline */
  const handleRun = useCallback(async () => {
    if (!prompt.trim()) return;
    setIsPipelineRunning(true);

    /* Clear old HITL gates from previous pipeline runs */
    clearGates();

    try {
      /* use existing project OR create new */
      let project = currentProject;
      if (useExistingProject && selectedExistingProject) {
        const found = existingProjects.find((p) => p.project_id === selectedExistingProject);
        if (found) {
          project = found;
          setCurrentProject(found);
        }
      }
      if (!project) {
        const name = projectName.trim() || `${pipelineMode}-${Date.now()}`;
        project = await createProject(name, pipelineMode, prompt.slice(0, 200));
        setCurrentProject(project);
      }

      /* upload zip if attached (for brownfield, hybrid, etc.) */
      if (zipAttachment && project) {
        if (zipAttachment.type === "zip") {
          await uploadZip(project.project_id, zipAttachment.file);
        } else {
          await uploadFile(project.project_id, zipAttachment.file);
        }
        setZipAttachment(null);
      }

      /* Append reuse pipeline context to the prompt for hybrid/microservice */
      let finalPrompt = prompt;
      if (selectedReusePipeline && allowPipelineReuse) {
        const reusePipeline = pipelineHistory.find((p) => p.run_id === selectedReusePipeline);
        if (reusePipeline) {
          finalPrompt += `\n\n[REUSE_PIPELINE: run_id=${reusePipeline.run_id}, project=${reusePipeline.project_name}, mode=${reusePipeline.mode}]`;
        }
      }

      /* start pipeline */
      const run = await startPipeline(pipelineMode, finalPrompt, project.project_id);
      setCurrentRun(run);

      /* pipeline tracker is now a horizontal bar — no sidebar switch needed */

      /* WebSocket for real-time tracking */
      const ws = connectPipelineWs(run.run_id);

      ws.onopen = () => { setWsConnected(true); };
      ws.onclose = () => { setWsConnected(false); };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);

          if (data.type === "hitl_gate" && data.gate) {
            const gate: HitlGate = {
              gate_id: data.gate.gate_id,
              type: data.gate.type ?? "hitl",
              label: data.gate.label,
              detail: data.gate.detail ?? "",
              report_file: data.gate.report_file,
              status: "pending",
              created_at: data.gate.created_at ?? new Date().toISOString(),
            };
            addPendingGate(gate);
            return;
          }

          if (data.type === "status") {
            updateCurrentRun({
              status: data.status,
              steps: data.steps,
              progress: data.progress,
              output_dir: data.output_dir,
            });
            // Push real-time status into React Query cache so it stays the source of truth
            qc.setQueryData(queryKeys.codeBuilder.runStatus(run.run_id), (old: any) => ({
              ...old,
              status: data.status,
              steps: data.steps,
              progress: data.progress,
              output_dir: data.output_dir,
            }));
          } else if (data.type === "pipeline_complete") {
            updateCurrentRun({
              status: "completed",
              progress: 100,
              output_dir: data.output_dir,
            });
            setIsPipelineRunning(false);
            addRunHistory(data);
            setOutputRunId(run.run_id);
            setActiveSidebarTab("output");
            qc.invalidateQueries({ queryKey: ["cb-runs"] });
            qc.invalidateQueries({ queryKey: queryKeys.codeBuilder.runStatus(run.run_id) });
          } else if (data.type === "pipeline_error") {
            updateCurrentRun({ status: "failed" });
            setIsPipelineRunning(false);
            qc.invalidateQueries({ queryKey: ["cb-runs"] });
            qc.invalidateQueries({ queryKey: queryKeys.codeBuilder.runStatus(run.run_id) });
          }
        } catch { /* ignore parse */ }
      };

      ws.onerror = () => { setWsConnected(false); ws.close(); };

      /* polling fallback is handled by usePipelineRunStatus hook */

    } catch (err) {
      console.error("Pipeline launch failed:", err);
      setIsPipelineRunning(false);
    }
  }, [prompt, pipelineMode, currentProject, projectName, zipAttachment, qc]);

  /* extract to project */
  const handleExtract = useCallback(async () => {
    if (!currentRun?.run_id || !currentProject) return;
    try {
      await extractOutputToProject(currentRun.run_id, currentProject.project_id);
      qc.invalidateQueries({ queryKey: queryKeys.codeBuilder.fileTree(currentProject.project_id) });
      setActiveSidebarTab("explorer");
    } catch (err) {
      console.error("Extract failed:", err);
    }
  }, [currentRun, currentProject, qc]);

  /* download zip */
  const handleDownload = useCallback(async () => {
    if (!currentRun?.run_id) return;
    setDownloading(true);
    try {
      await downloadPipelineOutput(currentRun.run_id);
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  }, [currentRun]);

  return (
    <div className="h-full flex flex-col bg-editor-sidebar border-b border-editor-border">
      {/* header */}
      <div className="panel-header cursor-pointer" onClick={toggleBuilderExpanded}>
        <div className="flex items-center gap-1.5">
          <Sparkles size={13} className="text-editor-accent" />
          <span>AI Code Builder</span>
          {isPipelineRunning && (
            <Loader2 size={12} className="text-editor-accent animate-spin ml-1" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {isCompleted && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-medium">
              Done
            </span>
          )}
          {isBuilderExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </div>
      </div>

      {isBuilderExpanded && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* mode selector */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1 uppercase tracking-wider">
              Pipeline Mode
            </label>
            <ModeSelector />
          </div>

          {/* new project name */}
          {!useExistingProject && (showNewProject || !currentProject) && (
            <div className="animate-fade-in">
              <label className="block text-[11px] text-gray-400 mb-1 uppercase tracking-wider">
                Project Name
              </label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="my-awesome-app"
                className="input-field text-xs"
              />
            </div>
          )}

          {/* Existing project selection for microservice/code_intel/hybrid/brownfield */}
          {allowExistingProject && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-2 mb-1.5">
                <button
                  onClick={() => { setUseExistingProject(!useExistingProject); setSelectedExistingProject(""); }}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    useExistingProject
                      ? "bg-editor-accent/20 border-editor-accent text-editor-accent"
                      : "bg-editor-input border-editor-border text-gray-400 hover:text-gray-300"
                  }`}
                >
                  {useExistingProject ? "✓ Using Existing Project" : "Use Existing Project"}
                </button>
                {loadingProjects && <Loader2 size={10} className="animate-spin text-gray-500" />}
              </div>
              {useExistingProject && (
                <select
                  value={selectedExistingProject}
                  onChange={(e) => {
                    setSelectedExistingProject(e.target.value);
                    const found = existingProjects.find((p) => p.project_id === e.target.value);
                    if (found) setCurrentProject(found);
                  }}
                  className="input-field text-xs w-full"
                >
                  <option value="">— Select a project —</option>
                  {existingProjects.map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name} ({p.mode}) — {new Date(p.created_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Pipeline reuse for hybrid (choose brownfield to reuse) */}
          {allowPipelineReuse && (
            <div>
              <button
                onClick={() => setShowPipelineReuse(!showPipelineReuse)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors mb-1.5 ${
                  showPipelineReuse
                    ? "bg-violet-500/20 border-violet-500 text-violet-300"
                    : "bg-editor-input border-editor-border text-gray-400 hover:text-gray-300"
                }`}
              >
                {pipelineMode === "hybrid" ? "Choose Brownfield to Reuse" : "Reuse Existing Pipeline"}
              </button>
              {showPipelineReuse && (
                <select
                  value={selectedReusePipeline}
                  onChange={(e) => setSelectedReusePipeline(e.target.value)}
                  className="input-field text-xs w-full"
                >
                  <option value="">— Select a completed pipeline —</option>
                  {pipelineHistory
                    .filter((p) => pipelineMode === "hybrid" ? p.mode === "brownfield" : true)
                    .map((p) => (
                      <option key={p.run_id} value={p.run_id}>
                        {p.project_name} — {p.mode} — {new Date(p.created_at).toLocaleDateString()}
                      </option>
                    ))}
                </select>
              )}
            </div>
          )}

          {/* active project badge */}
          {currentProject && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-editor-active rounded text-xs">
              <FolderPlus size={12} className="text-editor-accent" />
              <span className="text-gray-300 truncate flex-1">{currentProject.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setShowNewProject(!showNewProject); }}
                className="text-[10px] text-gray-500 hover:text-gray-300"
              >
                change
              </button>
            </div>
          )}

          {/* Zip upload for brownfield modes */}
          {needsZip && (
            <div>
              <label className="block text-[11px] text-gray-400 mb-1 uppercase tracking-wider">
                Upload Existing Code
              </label>
              <div className="flex gap-1.5">
                <button
                  onClick={() => zipInputRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded
                             bg-editor-input border border-editor-border border-dashed
                             hover:border-editor-accent text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <FolderArchive size={14} />
                  Upload ZIP
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded
                             bg-editor-input border border-editor-border border-dashed
                             hover:border-editor-accent text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <FileUp size={14} />
                  File
                </button>
              </div>
              <input ref={zipInputRef} type="file" accept=".zip" className="hidden"
                onChange={(e) => handleFilePick(e, "zip")} />
              <input ref={fileInputRef} type="file" className="hidden"
                onChange={(e) => handleFilePick(e, "file")} />
            </div>
          )}

          {/* Attachment preview */}
          {zipAttachment && (
            <div className="flex items-center gap-2 text-xs text-gray-300 bg-editor-input px-2.5 py-1.5 rounded border border-editor-border animate-fade-in">
              {zipAttachment.type === "zip" ? <FolderArchive size={13} /> : <FileUp size={13} />}
              <span className="truncate flex-1">{zipAttachment.file.name}</span>
              <span className="text-gray-500">({(zipAttachment.file.size / 1024).toFixed(0)}KB)</span>
              <button onClick={() => setZipAttachment(null)} className="p-0.5 rounded hover:bg-editor-border">
                <X size={12} />
              </button>
            </div>
          )}

          {/* prompt */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1 uppercase tracking-wider">
              Build Request
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={PLACEHOLDERS[pipelineMode]}
              rows={5}
              className="input-field resize-none leading-relaxed text-xs"
            />
          </div>

          {/* action buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleRun}
              disabled={isPipelineRunning || isActive || !prompt.trim()}
              className="btn-primary flex items-center gap-1.5 flex-1 justify-center text-xs
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPipelineRunning || isActive ? (
                <><Loader2 size={13} className="animate-spin" />Running…</>
              ) : (
                <><Play size={13} />Build</>
              )}
            </button>
            {isActive && (
              <button className="btn-secondary flex items-center gap-1.5 text-xs">
                <StopCircle size={13} />
                Stop
              </button>
            )}
          </div>

          {/* Post-build actions */}
          {isCompleted && currentRun && (
            <div className="space-y-2 pt-1 border-t border-editor-border">
              <p className="text-[11px] text-emerald-400 font-medium">Pipeline completed successfully!</p>
              <div className="flex gap-2">
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium
                             bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
                >
                  {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  Download ZIP
                </button>
                <button
                  onClick={handleExtract}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium
                             bg-editor-accent hover:bg-editor-accentHover text-white transition-colors"
                >
                  <Package size={12} />
                  Extract to Project
                </button>
              </div>
            </div>
          )}

          {/* tips */}
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Tips</p>
            <ul className="text-[11px] text-gray-400 space-y-0.5 list-disc pl-3.5">
              <li>Be specific about tech stack and features</li>
              {needsZip && <li>Upload your existing codebase as ZIP for analysis</li>}
              {pipelineMode === "code_intel" && <li>Upload ZIP or select existing project for code analysis</li>}
              {pipelineMode === "microservice" && <li>Upload existing architecture ZIP to modify or design new</li>}
              {pipelineMode === "hybrid" && <li>Select a brownfield pipeline to reuse its analysis</li>}
              {pipelineMode === "migration" && <li>Specify source and target frameworks clearly</li>}
              <li>Pipeline will generate full project structure</li>
              <li>HITL gates will appear in Pipeline Tracker for review</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
