"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Upload,
  FolderOpen,
  GitBranch,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  FileCode,
  Settings,
  ChevronDown,
  ChevronRight,
  Database,
} from "lucide-react";
import { authFetch } from "@/lib/auth";
import { useJobPoll } from "@/hooks/useJobPoll";
import { BufferedProgressBar } from "@/components/shared/BufferedProgressBar";
import { CancelJobButton } from "@/components/shared/CancelJobButton";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type SourceMode = "upload" | "git" | "local";

interface UploadIngestPanelProps {
  projectId?: number | null;
  onIngestComplete?: () => void;
}

export default function UploadIngestPanel({
  projectId,
  onIngestComplete,
}: UploadIngestPanelProps) {
  const [sourceMode, setSourceMode] = useState<SourceMode>("upload");

  // Upload state
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const zipRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // Git state
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");

  // Local path state
  const [localPath, setLocalPath] = useState("");

  // Options
  const [showOptions, setShowOptions] = useState(false);
  const [fileTypes, setFileTypes] = useState(".py,.ts,.js,.tsx,.jsx,.java,.go,.cs");
  const [maxFiles, setMaxFiles] = useState(500);
  const [enrichLimit, setEnrichLimit] = useState(50);

  // Progress state
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobPoll = useJobPoll({
    onComplete: (status) => {
      setLoading(false);
      setProgress(100);
      setStageLabel("Complete");
      setResult(status.result ?? { message: "Ingestion completed" });
      onIngestComplete?.();
    },
    onFail: (status) => {
      setLoading(false);
      setError(status.error_message ?? status.error ?? "Ingestion failed");
    },
    onCancel: () => {
      setLoading(false);
      setError("Ingestion cancelled");
    },
  });

  useEffect(() => {
    if (!jobPoll.status) return;
    setProgress(jobPoll.status.progress_pct ?? jobPoll.status.progress_percent ?? 0);
    setStageLabel(jobPoll.status.stage_detail || jobPoll.status.current_stage || null);
  }, [jobPoll.status]);

  // ── File helpers ───────────────────────────────────────────────────

  const getUploadFileKey = (file: File) => {
    const relPath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
    return `${relPath}::${file.size}::${file.lastModified}`;
  };

  const addUploadFiles = (files: FileList | null) => {
    if (!files) return;
    setUploadQueue((prev) => {
      const existingKeys = new Set(prev.map(getUploadFileKey));
      const next = [...prev];
      for (const file of Array.from(files)) {
        const fileKey = getUploadFileKey(file);
        if (!existingKeys.has(fileKey)) {
          existingKeys.add(fileKey);
          next.push(file);
        }
      }
      return next;
    });
  };

  const removeUploadFile = (idx: number) => {
    setUploadQueue((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Ingest handler ────────────────────────────────────────────────

  const handleIngest = async () => {
    if (!projectId) return;

    setLoading(true);
    setProgress(0);
    setStageLabel(null);
    setResult(null);
    setError(null);

    try {
      let submitRes: Response;
      if (sourceMode === "upload") {
        // Async upload
        const form = new FormData();
        form.append("project_id", String(projectId));
        form.append("file_types", fileTypes);
        form.append("max_files", String(maxFiles));
        form.append("enrich_limit", String(enrichLimit));
        form.append("dry_run", "false");

        for (const file of uploadQueue) {
          const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
          form.append("files", file, relPath && relPath.trim() ? relPath : file.name);
        }

        setStageLabel("Uploading");
        submitRes = await authFetch(`${API}/api/v1/ingest/code/upload/async`, {
          method: "POST",
          body: form,
        });

        if (!submitRes.ok) {
          const err = await submitRes.json().catch(() => ({ detail: submitRes.statusText }));
          throw new Error(err.detail ?? "Code ingest failed");
        }

      } else {
        // Async (git / local path)
        const payload = {
          project_id: projectId,
          repo_url: sourceMode === "git" ? repoUrl : null,
          branch: branch || "main",
          local_path: sourceMode === "local" ? localPath : null,
          file_types: fileTypes.split(",").map((s) => s.trim()).filter(Boolean),
          max_files: maxFiles,
          enrich_limit: enrichLimit,
          dry_run: false,
        };

        submitRes = await authFetch(`${API}/api/v1/ingest/code/async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!submitRes.ok) {
          const err = await submitRes.json().catch(() => ({ detail: submitRes.statusText }));
          throw new Error(err.detail ?? "Failed to submit ingest job");
        }

      }
      const submitData = await submitRes.json();
      const jobId = submitData.job_id;
      setStageLabel(submitData.status === "running" ? "Already running" : "Queued");
      jobPoll.startPolling(
        jobId,
        `${API}/api/v1/ingest/code/jobs/${encodeURIComponent(jobId)}/status`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingest failed");
      setProgress(0);
      setStageLabel(null);
      setLoading(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    setProgress(0);
    setStageLabel(null);
    setUploadQueue([]);
  };

  // ── Disable logic ─────────────────────────────────────────────────

  const canSubmit =
    !loading &&
    !!projectId &&
    ((sourceMode === "upload" && uploadQueue.length > 0) ||
      (sourceMode === "git" && repoUrl.trim().length > 0) ||
      (sourceMode === "local" && localPath.trim().length > 0));

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text">
      {/* Header */}
      <div className="px-4 py-2 text-[11px] font-sans uppercase tracking-wider text-cbv2-text-dim border-b border-cbv2-border flex items-center gap-2">
        <Database className="w-3.5 h-3.5" />
        <span>Upload &amp; Analyze</span>
      </div>

      <div className="flex-1 overflow-y-auto cbv2-scrollbar">
        {!projectId && (
          <div className="px-4 py-6 text-center text-cbv2-text-dim text-[12px]">
            <Database className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>Select a project first</p>
            <p className="text-[11px] mt-1">
              Use the Chat panel to select a project, then upload source code here.
            </p>
          </div>
        )}

        {projectId && (
          <div className="p-3 space-y-3">
            {/* Source mode switcher */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-md bg-cbv2-input border border-cbv2-border">
              {(
                [
                  { id: "upload" as SourceMode, label: "Upload", icon: Upload },
                  { id: "git" as SourceMode, label: "Git URL", icon: GitBranch },
                  { id: "local" as SourceMode, label: "Local", icon: FolderOpen },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={[
                    "flex items-center justify-center gap-1 py-1.5 rounded text-[11px] font-medium transition-colors",
                    sourceMode === id
                      ? "bg-cbv2-accent text-white"
                      : "text-cbv2-text-dim hover:text-white hover:bg-cbv2-hover",
                  ].join(" ")}
                  onClick={() => setSourceMode(id)}
                  disabled={loading}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>

            {/* Upload mode */}
            {sourceMode === "upload" && (
              <div className="space-y-2">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragActive(true);
                  }}
                  onDragLeave={() => setIsDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragActive(false);
                    addUploadFiles(e.dataTransfer.files);
                  }}
                  className={[
                    "rounded-lg border-2 border-dashed p-3 text-center transition-colors",
                    isDragActive
                      ? "border-cbv2-accent bg-cbv2-accent/10"
                      : "border-cbv2-border hover:border-cbv2-text-dim",
                  ].join(" ")}
                >
                  <Upload className="w-6 h-6 mx-auto mb-1.5 text-cbv2-text-dim" />
                  <p className="text-[11px] text-cbv2-text-dim mb-2">
                    Drop ZIP or files here
                  </p>
                  <div className="flex justify-center gap-2">
                    <button
                      className="px-2.5 py-1 rounded border border-cbv2-border text-[10px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => zipRef.current?.click()}
                      disabled={loading}
                    >
                      Upload .zip
                    </button>
                    <button
                      className="px-2.5 py-1 rounded border border-cbv2-border text-[10px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => folderRef.current?.click()}
                      disabled={loading}
                    >
                      Browse Folder
                    </button>
                  </div>
                </div>

                <input
                  ref={zipRef}
                  type="file"
                  accept=".zip"
                  multiple
                  className="hidden"
                  onChange={(e) => addUploadFiles(e.target.files)}
                />
                <input
                  ref={folderRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => addUploadFiles(e.target.files)}
                  {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
                />

                {uploadQueue.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded border border-cbv2-border divide-y divide-cbv2-border/50 cbv2-scrollbar">
                    {uploadQueue.map((file, i) => (
                      <div
                        key={`${file.name}-${i}`}
                        className="flex items-center gap-1.5 px-2 py-1"
                      >
                        <FileCode className="w-3 h-3 text-cbv2-text-dim shrink-0" />
                        <span className="text-[11px] text-cbv2-text truncate flex-1">
                          {file.name}
                        </span>
                        <span className="text-[10px] text-cbv2-text-dim">
                          {(file.size / 1024).toFixed(0)}K
                        </span>
                        <button
                          onClick={() => removeUploadFile(i)}
                          className="text-cbv2-text-dim hover:text-red-400 transition-colors"
                          disabled={loading}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Git URL mode */}
            {sourceMode === "git" && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide">
                    Repository URL
                  </label>
                  <input
                    type="text"
                    placeholder="https://github.com/org/repo.git"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    disabled={loading}
                    className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim/50 outline-none focus:border-cbv2-accent transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide">
                    Branch
                  </label>
                  <input
                    type="text"
                    placeholder="main"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={loading}
                    className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim/50 outline-none focus:border-cbv2-accent transition-colors"
                  />
                </div>
              </div>
            )}

            {/* Local path mode */}
            {sourceMode === "local" && (
              <div className="space-y-1">
                <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide">
                  Local Repository Path
                </label>
                <input
                  type="text"
                  placeholder="C:\Projects\my-repo"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  disabled={loading}
                  className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim/50 outline-none focus:border-cbv2-accent transition-colors"
                />
                <p className="text-[10px] text-cbv2-text-dim">
                  Absolute path on the server.
                </p>
              </div>
            )}

            {/* Options toggle */}
            <button
              className="flex items-center gap-1.5 text-[11px] text-cbv2-text-dim hover:text-cbv2-text transition-colors w-full"
              onClick={() => setShowOptions((v) => !v)}
            >
              {showOptions ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Settings className="w-3 h-3" />
              Options
            </button>

            {showOptions && (
              <div className="space-y-2 pl-2 border-l border-cbv2-border">
                <div className="space-y-1">
                  <label className="text-[10px] text-cbv2-text-dim">
                    File Extensions
                  </label>
                  <input
                    type="text"
                    value={fileTypes}
                    onChange={(e) => setFileTypes(e.target.value)}
                    disabled={loading}
                    className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text outline-none focus:border-cbv2-accent"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[10px] text-cbv2-text-dim">
                      Max Files
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      value={maxFiles}
                      onChange={(e) => setMaxFiles(Number(e.target.value))}
                      disabled={loading}
                      className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text outline-none focus:border-cbv2-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-cbv2-text-dim">
                      Enrich Limit
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={500}
                      value={enrichLimit}
                      onChange={(e) => setEnrichLimit(Number(e.target.value))}
                      disabled={loading}
                      className="w-full h-7 bg-cbv2-input border border-cbv2-border rounded px-2 text-[11px] text-cbv2-text outline-none focus:border-cbv2-accent"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Progress bar */}
            {loading && (
              <div className="space-y-1">
                <BufferedProgressBar
                  progress={progress}
                  stage={stageLabel}
                  detail={jobPoll.status?.stage_detail}
                  filesDone={jobPoll.status?.files_done}
                  filesTotal={jobPoll.status?.files_total}
                />
                {jobPoll.isPolling && (
                  <div className="flex justify-end">
                    <CancelJobButton onCancel={jobPoll.cancel} size="sm" />
                  </div>
                )}
                {jobPoll.error && (
                  <p className="text-[10px] text-amber-400">{jobPoll.error}</p>
                )}
              </div>
            )}

            {/* Result */}
            {result && (
              <div className="rounded-lg border border-green-800/60 bg-green-950/20 p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-green-400 text-[11px] font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {(result.message as string) || "Ingestion complete"}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { label: "Files", value: result.files_analyzed },
                    { label: "Vectors", value: result.vectors_stored },
                    { label: "Nodes", value: result.graph_nodes },
                    { label: "Edges", value: result.graph_edges },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      className="rounded bg-cbv2-input/50 px-2 py-1.5 text-center"
                    >
                      <p className="text-[13px] font-bold text-cbv2-text">
                        {value != null ? String(value) : "—"}
                      </p>
                      <p className="text-[9px] text-cbv2-text-dim">{label}</p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleReset}
                  className="w-full mt-1 py-1 rounded text-[11px] text-cbv2-text-dim hover:text-cbv2-text border border-cbv2-border hover:bg-cbv2-hover transition-colors"
                >
                  Upload More
                </button>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-1.5 rounded-lg border border-red-800/60 bg-red-950/20 px-3 py-2 text-[11px] text-red-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit button */}
            {!result && (
              <button
                onClick={handleIngest}
                disabled={!canSubmit}
                className={[
                  "w-full flex items-center justify-center gap-2 py-2 rounded text-[12px] font-medium transition-colors",
                  canSubmit
                    ? "bg-cbv2-accent text-white hover:bg-cbv2-accent/90"
                    : "bg-cbv2-input text-cbv2-text-dim cursor-not-allowed",
                ].join(" ")}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Analyzing &amp; Indexing…
                  </>
                ) : (
                  <>
                    <Database className="w-3.5 h-3.5" />
                    Analyze &amp; Ingest
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
