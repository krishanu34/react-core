"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown, Search, Loader2, CheckCircle2,
  FileText, Code2, Figma, Upload, X, RefreshCw, FolderOpen,
  GitBranch, Server, Key, AlertCircle, ChevronRight, Settings,
} from "lucide-react";
import {
  fetchGitLabBranches,
  type DbProject,
} from "@/hooks/useDbProjects";
import { authFetch } from "@/lib/auth";
import { useGlobalProject } from "@/providers/ProjectProvider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const FILE_TYPE_LABELS: Record<string, { label: string; desc: string; accept: string }> = {
  requirements: { label: "Requirements",       desc: "BRD, PRD, functional specs",             accept: ".pdf,.docx,.txt,.md" },
  architecture: { label: "Architecture / ADR", desc: "Architecture decision records, C4 docs", accept: ".pdf,.docx,.txt,.md" },
  api_spec:     { label: "API Specifications", desc: "OpenAPI, AsyncAPI, WSDL",                accept: ".yaml,.yml,.json,.xml" },
  test_cases:   { label: "Test Cases",         desc: "Existing test suites for context",       accept: ".feature,.txt,.csv" },
};

const inputCls =
  "w-full h-8 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2.5 text-xs text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500";

/* ── Shared modal shell ────────────────────────────────────────────── */

function ModalShell({
  title,
  icon,
  busy,
  onClose,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  busy?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (busy) {
          setShowConfirm(true);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [busy, onClose]);

  return createPortal(
    <>
      {/* Backdrop — no click-to-close, matches existing ingest modals */}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="flex flex-col w-full max-w-lg mx-4 max-h-[80vh] rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--ide-border)] shrink-0">
            {icon}
            <h2 className="text-sm font-semibold text-[var(--ide-text)] flex-1">{title}</h2>
            <button
              type="button"
              onClick={() => {
                if (busy) {
                  setShowConfirm(true);
                } else {
                  onClose();
                }
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {children}
          </div>
        </div>
      </div>

      {/* Cancel confirmation */}
      {showConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--ide-text)]">Cancel in-progress operation?</h3>
            <p className="text-xs text-[var(--ide-muted)] leading-relaxed">
              An operation is currently in progress. Are you sure you want to close? This may interrupt the process.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowConfirm(false)}
                className="h-8 px-3 rounded-md border border-[var(--ide-border)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors">
                Stay Here
              </button>
              <button type="button" onClick={() => { setShowConfirm(false); onClose(); }}
                className="h-8 px-3 rounded-md bg-red-600 hover:bg-red-500 text-xs font-medium text-white transition-colors">
                Yes, Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

/* ── Shared file queue ─────────────────────────────────────────────── */

function FileQueue({
  files,
  onRemove,
}: {
  files: { file: File; status: string }[];
  onRemove: (idx: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="space-y-1 max-h-36 overflow-y-auto rounded-md border border-[var(--ide-border)]">
      {files.map((item, i) => (
        <div key={`${item.file.name}-${i}`}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
          {item.status === "done" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          ) : item.status === "error" ? (
            <X className="h-3.5 w-3.5 text-red-400 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-[var(--ide-muted)] shrink-0" />
          )}
          <span className="flex-1 truncate text-[var(--ide-text)]">{item.file.name}</span>
          <span className="text-[var(--ide-muted)] shrink-0 text-[10px]">{(item.file.size / 1024).toFixed(0)}K</span>
          {item.status === "pending" && (
            <button type="button" onClick={() => onRemove(i)}
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-red-950/40 text-[var(--ide-muted)] hover:text-red-400">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusBanner({ result, error }: { result: string | null; error: string | null }) {
  return (
    <>
      {result && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-emerald-950/30 border border-emerald-800/40">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-300">{result}</p>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-red-950/30 border border-red-800/40">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
    </>
  );
}

/* ── Documents Modal ───────────────────────────────────────────────── */

function DocsModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [selectedType, setSelectedType] = useState("requirements");
  const [localPath, setLocalPath] = useState("");
  const [queue, setQueue] = useState<{ file: File; status: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setQueue((prev) => [...prev, ...Array.from(files).map((f) => ({ file: f, status: "pending" }))]);
    setResult(null); setError(null);
  };

  const handleUpload = async () => {
    const pending = queue.filter((f) => f.status === "pending");
    if (!pending.length && !localPath.trim()) return;
    setUploading(true); setError(null); setResult(null);

    const form = new FormData();
    form.append("project_id", String(projectId));
    form.append("dry_run", "false");
    if (localPath.trim()) form.append("local_path", localPath.trim());
    form.append("confluence_urls", JSON.stringify([]));
    if (pending.length === 0) {
      form.append("files", new Blob([]), "placeholder.txt");
    } else {
      for (const item of pending) form.append("files", item.file);
    }

    try {
      const res = await authFetch(`${API}/api/v1/ingest/docs`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Upload failed");
      }
      const data = await res.json();
      setResult(`${data.source_files ?? 0} files ingested, ${data.chunks_created ?? 0} chunks created`);
      setQueue((prev) => prev.map((f) => f.status === "pending" ? { ...f, status: "done" } : f));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setQueue((prev) => prev.map((f) => f.status === "pending" ? { ...f, status: "error" } : f));
    } finally {
      setUploading(false);
    }
  };

  const pendingCount = queue.filter((f) => f.status === "pending").length;
  const currentAccept = FILE_TYPE_LABELS[selectedType]?.accept ?? ".pdf,.docx,.txt,.md";
  const hasInput = pendingCount > 0 || localPath.trim().length > 0;

  return (
    <ModalShell title="Upload Documents" icon={<FileText className="h-5 w-5 text-sky-400" />} busy={uploading} onClose={onClose}>
      <p className="text-xs text-[var(--ide-muted)]">
        Upload requirements, architecture docs, API specs, and test cases for ingestion.
      </p>

      {/* Document type selector */}
      <div>
        <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1.5">Document Type</label>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(FILE_TYPE_LABELS).map(([key, { label, desc }]) => (
            <button key={key} type="button" onClick={() => setSelectedType(key)}
              title={desc}
              className={`h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
                selectedType === key
                  ? "bg-violet-600/20 text-violet-300 border border-violet-500/40"
                  : "text-[var(--ide-muted)] border border-[var(--ide-border)] hover:border-[var(--ide-muted)]"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--ide-muted)] mt-1">
          {FILE_TYPE_LABELS[selectedType]?.desc} — accepts {currentAccept}
        </p>
      </div>

      {/* File upload */}
      <input ref={fileRef} type="file" accept={currentAccept} multiple className="hidden"
        onChange={(e) => addFiles(e.target.files)} />
      <button type="button" onClick={() => fileRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 h-10 rounded-lg border-2 border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
        <Upload className="h-4 w-4" /> Choose Files
      </button>

      <FileQueue files={queue} onRemove={(i) => setQueue((prev) => prev.filter((_, j) => j !== i))} />

      {/* Server path */}
      <div>
        <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">
          Server Path <span className="font-normal">(optional)</span>
        </label>
        <input value={localPath} onChange={(e) => setLocalPath(e.target.value)}
          placeholder="/path/to/documents" className={inputCls} />
        <p className="text-[10px] text-[var(--ide-muted)] mt-0.5">Absolute path on the server.</p>
      </div>

      {hasInput && (
        <button type="button" onClick={handleUpload} disabled={uploading}
          className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-50 text-xs font-medium text-white transition-all">
          {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</>
            : <><Upload className="h-4 w-4" /> Ingest Documents</>}
        </button>
      )}

      <StatusBanner result={result} error={error} />
    </ModalShell>
  );
}

/* ── Code Modal ────────────────────────────────────────────────────── */

function CodeModal({
  projectId,
  gitlabConfig,
  onClose,
}: {
  projectId: number;
  gitlabConfig?: { git_urls?: string[] } | null;
  onClose: () => void;
}) {
  type SourceMode = "upload" | "git" | "local";

  const gitlabUrls = (gitlabConfig?.git_urls ?? []).filter(Boolean);

  const [sourceMode, setSourceMode] = useState<SourceMode>("upload");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchErr, setBranchErr] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [fileTypes, setFileTypes] = useState(".py,.ts,.js,.tsx,.jsx,.java,.go,.cs");
  const [maxFiles, setMaxFiles] = useState(500);
  const [enrichLimit, setEnrichLimit] = useState(50);
  const [showOptions, setShowOptions] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [resultData, setResultData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const getFileKey = (file: File) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
    return `${rel}::${file.size}::${file.lastModified}`;
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setUploadQueue((prev) => {
      const keys = new Set(prev.map(getFileKey));
      const next = [...prev];
      for (const f of Array.from(files)) {
        const k = getFileKey(f);
        if (!keys.has(k)) { keys.add(k); next.push(f); }
      }
      return next;
    });
  };

  const doFetchBranches = async (url: string) => {
    if (!url) return;
    setLoadingBranches(true);
    setBranchErr(null); setBranches([]); setBranch("main");
    try {
      const data = await fetchGitLabBranches(projectId, url);
      setBranches(data.branches);
      if (data.branches.length > 0) setBranch(data.branches[0]);
    } catch (e) {
      setBranchErr(e instanceof Error ? e.message : "Failed to fetch branches");
    } finally {
      setLoadingBranches(false);
    }
  };

  const handleReset = () => {
    setResultData(null); setError(null); setProgress(0); setStageLabel(null); setUploadQueue([]);
  };

  const handleIngest = async () => {
    setLoading(true); setProgress(0); setStageLabel(null); setResultData(null); setError(null);

    try {
      let jobId: string;

      if (sourceMode === "upload") {
        const form = new FormData();
        form.append("project_id", String(projectId));
        form.append("file_types", fileTypes);
        form.append("max_files", String(maxFiles));
        form.append("enrich_limit", String(enrichLimit));
        form.append("dry_run", "false");
        for (const file of uploadQueue) {
          const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
          form.append("files", file, relPath?.trim() ? relPath : file.name);
        }
        setStageLabel("Uploading");
        const submitRes = await authFetch(`${API}/api/v1/ingest/code/upload/async`, { method: "POST", body: form });
        if (!submitRes.ok) {
          const err = await submitRes.json().catch(() => ({ detail: submitRes.statusText }));
          throw new Error(err.detail ?? "Upload failed");
        }
        jobId = (await submitRes.json()).job_id;
      } else {
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
        const submitRes = await authFetch(`${API}/api/v1/ingest/code/async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!submitRes.ok) {
          const err = await submitRes.json().catch(() => ({ detail: submitRes.statusText }));
          throw new Error(err.detail ?? "Ingest failed");
        }
        jobId = (await submitRes.json()).job_id;
      }

      setStageLabel("Queued");
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          try {
            const res = await authFetch(`${API}/api/v1/ingest/code/jobs/${encodeURIComponent(jobId)}/status`);
            if (!res.ok) return;
            const data = await res.json();
            setProgress(data.progress_percent ?? 0);
            setStageLabel(data.stage_detail || data.current_stage || null);
            if (data.status === "completed") {
              stopPoll();
              setProgress(100);
              setStageLabel("Complete");
              setResultData(data.result ?? { message: "Ingestion completed" });
              resolve();
            } else if (data.status === "failed") {
              stopPoll();
              reject(new Error(data.error ?? "Ingestion failed"));
            }
          } catch { /* keep polling */ }
        };
        poll();
        pollRef.current = setInterval(poll, 2000);
      });
    } catch (e) {
      stopPoll();
      setError(e instanceof Error ? e.message : "Ingest failed");
      setProgress(0); setStageLabel(null);
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = !loading && !resultData && (
    (sourceMode === "upload" && uploadQueue.length > 0) ||
    (sourceMode === "git" && repoUrl.trim().length > 0) ||
    (sourceMode === "local" && localPath.trim().length > 0)
  );

  return (
    <ModalShell title="Upload Code References" icon={<Code2 className="h-5 w-5 text-emerald-400" />} busy={loading} onClose={onClose}>
      <p className="text-xs text-[var(--ide-muted)]">
        Index a codebase for implementation context. Choose a source below.
      </p>

      {/* Source mode selector */}
      <div className="flex gap-1 rounded-lg border border-[var(--ide-border)] p-1">
        {([
          { id: "upload" as SourceMode, label: "Upload",     Icon: Upload },
          { id: "git"    as SourceMode, label: "Git URL",    Icon: GitBranch },
          { id: "local"  as SourceMode, label: "Local Path", Icon: Server },
        ]).map(({ id, label, Icon }) => (
          <button key={id} type="button" onClick={() => setSourceMode(id)} disabled={loading}
            className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium transition-colors ${
              sourceMode === id
                ? "bg-violet-600/20 text-violet-300"
                : "text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
            }`}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {/* Upload mode */}
      {sourceMode === "upload" && (
        <>
          <input ref={zipRef} type="file" accept=".zip" multiple className="hidden"
            onChange={(e) => addFiles(e.target.files)} />
          <input ref={folderRef} type="file" multiple className="hidden"
            onChange={(e) => addFiles(e.target.files)}
            {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} />

          <p className="text-[11px] text-[var(--ide-muted)]">Upload a ZIP archive or browse a folder.</p>

          <div className="flex gap-2">
            <button type="button" onClick={() => zipRef.current?.click()} disabled={loading}
              className="flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg border-2 border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
              <Upload className="h-4 w-4" /> Upload .zip
            </button>
            <button type="button" onClick={() => folderRef.current?.click()} disabled={loading}
              className="flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg border-2 border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
              <FolderOpen className="h-4 w-4" /> Browse Folder
            </button>
          </div>

          {uploadQueue.length > 0 && (
            <div className="space-y-1 max-h-36 overflow-y-auto rounded-md border border-[var(--ide-border)]">
              {uploadQueue.map((file, i) => (
                <div key={`${file.name}-${i}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                  <Code2 className="h-3.5 w-3.5 text-[var(--ide-muted)] shrink-0" />
                  <span className="flex-1 truncate text-[var(--ide-text)]">{file.name}</span>
                  <span className="text-[var(--ide-muted)] text-[10px] shrink-0">{(file.size / 1024).toFixed(0)}K</span>
                  <button type="button" onClick={() => setUploadQueue((prev) => prev.filter((_, j) => j !== i))}
                    disabled={loading}
                    className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-red-950/40 text-[var(--ide-muted)] hover:text-red-400">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Git URL mode */}
      {sourceMode === "git" && (
        <>
          <div>
            <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Repository URL</label>
            {gitlabUrls.length > 0 ? (
              <select value={repoUrl}
                onChange={(e) => { setRepoUrl(e.target.value); if (e.target.value) doFetchBranches(e.target.value); }}
                disabled={loading}
                className={inputCls}>
                <option value="">— Select repository —</option>
                {gitlabUrls.map((u) => (
                  <option key={u} value={u}>{u.split("/").pop()?.replace(/\.git$/i, "") || u}</option>
                ))}
              </select>
            ) : (
              <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                disabled={loading}
                placeholder="https://github.com/org/repo.git" className={inputCls} />
            )}
          </div>
          <div>
            <label className="flex items-center justify-between text-[11px] font-medium text-[var(--ide-muted)] mb-1">
              Branch
              {loadingBranches && <Loader2 className="h-3 w-3 animate-spin text-[var(--ide-muted)]" />}
            </label>
            {branches.length > 0 ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={loading} className={inputCls}>
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <div className="flex gap-1.5">
                <input value={branch} onChange={(e) => setBranch(e.target.value)}
                  disabled={loading}
                  placeholder="main" className={`flex-1 ${inputCls}`} />
                <button type="button" onClick={() => doFetchBranches(repoUrl)}
                  disabled={!repoUrl.trim() || loadingBranches || loading}
                  className="h-8 px-3 rounded-md border border-[var(--ide-border)] text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] disabled:opacity-40 transition-colors">
                  Fetch
                </button>
              </div>
            )}
            {branchErr && <p className="text-[10px] text-red-400 mt-0.5">{branchErr}</p>}
          </div>
        </>
      )}

      {/* Local path mode */}
      {sourceMode === "local" && (
        <div>
          <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Server Path</label>
          <input value={localPath} onChange={(e) => setLocalPath(e.target.value)}
            disabled={loading}
            placeholder="C:\Projects\my-repo" className={inputCls} />
          <p className="text-[10px] text-[var(--ide-muted)] mt-0.5">Absolute path on the server.</p>
        </div>
      )}

      {/* Options toggle */}
      <button type="button"
        className="flex items-center gap-1.5 text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] transition-colors w-full"
        onClick={() => setShowOptions((v) => !v)}>
        {showOptions ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Settings className="h-3 w-3" />
        Options
      </button>

      {showOptions && (
        <div className="space-y-2 pl-2 border-l border-[var(--ide-border)]">
          <div>
            <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">File Extensions</label>
            <input value={fileTypes} onChange={(e) => setFileTypes(e.target.value)}
              disabled={loading}
              placeholder=".py,.ts,.java" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Max Files</label>
              <input type="number" min={1} max={5000} value={maxFiles}
                onChange={(e) => setMaxFiles(Number(e.target.value))}
                disabled={loading}
                className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Enrich Limit</label>
              <input type="number" min={0} max={500} value={enrichLimit}
                onChange={(e) => setEnrichLimit(Number(e.target.value))}
                disabled={loading}
                className={inputCls} />
            </div>
          </div>
        </div>
      )}

      {/* Progress bar */}
      {loading && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-[var(--ide-muted)]">
            <span>{stageLabel ? `Indexing — ${stageLabel}` : "Indexing…"}</span>
            <span>{progress.toFixed(0)}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--ide-surface)] overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 transition-all duration-300"
              style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* Result card */}
      {resultData && (
        <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-emerald-400 text-[11px] font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {(resultData.message as string) || "Ingestion complete"}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: "Files", value: resultData.files_analyzed },
              { label: "Vectors", value: resultData.vectors_stored },
              { label: "Nodes", value: resultData.graph_nodes },
              { label: "Edges", value: resultData.graph_edges },
            ].map(({ label, value }) => (
              <div key={label}
                className="rounded bg-[var(--ide-surface)] px-2 py-1.5 text-center">
                <p className="text-[13px] font-bold text-[var(--ide-text)]">
                  {value != null ? String(value) : "—"}
                </p>
                <p className="text-[9px] text-[var(--ide-muted)]">{label}</p>
              </div>
            ))}
          </div>
          <button type="button" onClick={handleReset}
            className="w-full mt-1 py-1.5 rounded text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] border border-[var(--ide-border)] hover:bg-[var(--ide-hover)] transition-colors">
            Upload More
          </button>
        </div>
      )}

      {canSubmit && (
        <button type="button" onClick={handleIngest} disabled={loading}
          className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-50 text-xs font-medium text-white transition-all">
          {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Indexing…</>
            : <><Code2 className="h-4 w-4" /> Analyze &amp; Ingest</>}
        </button>
      )}

      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2 text-[11px] text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </ModalShell>
  );
}

/* ── Figma Modal ───────────────────────────────────────────────────── */

function FigmaModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  type FigmaMode = "json" | "api";

  const [mode, setMode] = useState<FigmaMode>("json");
  const [queue, setQueue] = useState<{ file: File; status: string }[]>([]);
  const [figmaToken, setFigmaToken] = useState("");
  const [figmaUrls, setFigmaUrls] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const valid = Array.from(files).filter((f) =>
      f.name.endsWith(".json") || f.name.endsWith(".png") || f.name.endsWith(".jpg") || f.name.endsWith(".jpeg"),
    );
    setQueue((prev) => [...prev, ...valid.map((f) => ({ file: f, status: "pending" }))]);
    setResult(null); setError(null);
  };

  const handleUpload = async () => {
    setUploading(true); setResult(null); setError(null);

    try {
      const form = new FormData();
      form.append("project_id", String(projectId));
      form.append("dry_run", "false");

      let endpoint: string;
      if (mode === "json") {
        const pending = queue.filter((f) => f.status === "pending");
        if (!pending.length) { setUploading(false); return; }
        for (const item of pending) form.append("files", item.file);
        endpoint = `${API}/api/v1/ingest/figma/json`;
      } else {
        if (!figmaToken.trim() || !figmaUrls.trim()) { setUploading(false); return; }
        form.append("figma_token", figmaToken.trim());
        form.append("figma_urls", figmaUrls.trim());
        endpoint = `${API}/api/v1/ingest/figma/api`;
      }

      const res = await authFetch(endpoint, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Upload failed");
      }
      const data = await res.json();
      setResult(`${data.files_processed ?? 0} files processed, ${data.chunks_added ?? 0} chunks added`);
      if (mode === "json") {
        setQueue((prev) => prev.map((f) => f.status === "pending" ? { ...f, status: "done" } : f));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const pendingCount = queue.filter((f) => f.status === "pending").length;
  const canSubmit = !uploading && (
    (mode === "json" && pendingCount > 0) ||
    (mode === "api" && figmaToken.trim().length > 0 && figmaUrls.trim().length > 0)
  );

  return (
    <ModalShell title="Upload Figma Exports" icon={<Figma className="h-5 w-5 text-violet-400" />} busy={uploading} onClose={onClose}>
      <p className="text-xs text-[var(--ide-muted)]">
        Index Figma designs for design context.
      </p>

      {/* Mode selector */}
      <div className="flex gap-1 rounded-lg border border-[var(--ide-border)] p-1">
        {([
          { id: "json" as FigmaMode, label: "Upload Files",  Icon: Upload },
          { id: "api"  as FigmaMode, label: "Figma API",     Icon: Figma },
        ]).map(({ id, label, Icon }) => (
          <button key={id} type="button" onClick={() => setMode(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium transition-colors ${
              mode === id
                ? "bg-violet-600/20 text-violet-300"
                : "text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
            }`}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {/* JSON upload */}
      {mode === "json" && (
        <>
          <input ref={fileRef} type="file" accept=".json,.png,.jpg,.jpeg" multiple className="hidden"
            onChange={(e) => addFiles(e.target.files)} />

          <button type="button" onClick={() => fileRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 h-10 rounded-lg border-2 border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
            <Upload className="h-4 w-4" /> Choose Files (.json, .png, .jpg)
          </button>

          <FileQueue files={queue} onRemove={(i) => setQueue((prev) => prev.filter((_, j) => j !== i))} />
        </>
      )}

      {/* Figma API */}
      {mode === "api" && (
        <>
          <div>
            <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">
              Figma Personal Access Token
            </label>
            <div className="relative">
              <Key className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ide-muted)]" />
              <input type="password" value={figmaToken}
                onChange={(e) => setFigmaToken(e.target.value)}
                placeholder="figd_xxxx" className={`${inputCls} pl-8`} />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">
              Figma File URLs <span className="font-normal">(one per line)</span>
            </label>
            <textarea value={figmaUrls} onChange={(e) => setFigmaUrls(e.target.value)}
              placeholder={"https://www.figma.com/file/abc123/...\nhttps://www.figma.com/file/def456/..."}
              rows={3}
              className="w-full rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2.5 py-2 text-xs text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none" />
          </div>
        </>
      )}

      {canSubmit && (
        <button type="button" onClick={handleUpload} disabled={uploading}
          className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-50 text-xs font-medium text-white transition-all">
          {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</>
            : <><Figma className="h-4 w-4" /> {mode === "json" ? "Upload & Index" : "Sync from Figma"}</>}
        </button>
      )}

      <StatusBanner result={result} error={error} />
    </ModalShell>
  );
}

/* ── Project dropdown ──────────────────────────────────────────────── */

function ProjectDropdown({
  projects,
  loading,
  selectedId,
  onSelect,
  onRefresh,
}: {
  projects: DbProject[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (p: DbProject) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = projects.filter(
    (p) => !p.archived && p.name.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div ref={ref} className="relative">
      <label className="block text-[10px] font-medium text-[var(--ide-muted)] mb-1">Project</label>
      <div className="flex gap-1">
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="flex-1 flex items-center justify-between h-8 px-2 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs text-[var(--ide-text)] hover:border-[var(--ide-muted)] transition-colors min-w-0">
          <span className="truncate">{selected ? selected.name : "Select a project…"}</span>
          <ChevronDown className="h-3 w-3 text-[var(--ide-muted)] shrink-0" />
        </button>
        <button type="button" onClick={onRefresh} title="Refresh projects"
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md border border-[var(--ide-border)] text-[var(--ide-muted)] hover:text-[var(--ide-text)] transition-colors">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl max-h-60 overflow-hidden flex flex-col">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--ide-border)]">
            <Search className="h-3 w-3 text-[var(--ide-muted)] shrink-0" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="flex-1 bg-transparent text-xs text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none" />
          </div>
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--ide-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs text-[var(--ide-muted)]">No projects found.</p>
            ) : (
              filtered.map((p) => (
                <button key={p.id} type="button"
                  onClick={() => { onSelect(p); setOpen(false); setSearch(""); }}
                  className={`w-full text-left px-2 py-1.5 text-xs hover:bg-[var(--ide-hover)] transition-colors flex items-center gap-2 ${
                    p.id === selectedId ? "text-violet-300" : "text-[var(--ide-text)]"
                  }`}>
                  <span className="truncate flex-1">{p.name}</span>
                  {p.id === selectedId && <CheckCircle2 className="h-3 w-3 text-violet-400 shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main panel ────────────────────────────────────────────────────── */

export function AllContextPanel({ workspaceId }: { workspaceId: number }) {
  const { selectedProject, selectedProjectId } = useGlobalProject();
  const [openModal, setOpenModal] = useState<"docs" | "code" | "figma" | null>(null);

  const projectId = selectedProjectId ?? 0;

  const SECTIONS = [
    {
      id: "docs" as const,
      label: "Upload Documents",
      desc: "Requirements, architecture docs, API specs, test cases",
      Icon: FileText,
      iconColor: "text-sky-400",
      status: selectedProject?.has_doc_context,
    },
    {
      id: "code" as const,
      label: "Upload Code References",
      desc: "ZIP, Git clone, or local server path",
      Icon: Code2,
      iconColor: "text-emerald-400",
      status: selectedProject?.has_code_context,
    },
    {
      id: "figma" as const,
      label: "Upload Figma Exports",
      desc: "JSON exports or sync via Figma API",
      Icon: Figma,
      iconColor: "text-violet-400",
      status: selectedProject?.has_figma_context,
    },
  ];

  return (
    <div className="flex flex-col h-full text-[var(--ide-text)]">
      <div className="p-3 space-y-3 overflow-y-auto flex-1">
        <p className="text-[10px] text-[var(--ide-muted)] leading-relaxed">
          Upload documents, code, and Figma exports to build context for a project.
        </p>

        {selectedProject ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-violet-600/10 border border-violet-500/20">
            <CheckCircle2 className="h-3 w-3 text-violet-400 shrink-0" />
            <p className="text-[10px] text-violet-300 truncate">{selectedProject.name}</p>
          </div>
        ) : (
          <p className="text-[10px] text-amber-400/80 text-center">
            Select a project from the main app header or the Projects panel.
          </p>
        )}

        {/* Action cards */}
        <div className="space-y-1.5">
          {SECTIONS.map(({ id, label, desc, Icon, iconColor, status }) => (
            <button
              key={id}
              type="button"
              disabled={!selectedProject}
              onClick={() => setOpenModal(id)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-[var(--ide-border)] hover:border-[var(--ide-muted)] hover:bg-[var(--ide-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-left transition-colors group"
            >
              <div className="h-8 w-8 rounded-md bg-[var(--ide-surface)] border border-[var(--ide-border)] flex items-center justify-center shrink-0 group-hover:border-[var(--ide-muted)]">
                <Icon className={`h-4 w-4 ${iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-[var(--ide-text)]">{label}</p>
                <p className="text-[10px] text-[var(--ide-muted)] truncate">{desc}</p>
              </div>
              {status != null && (
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
                  status ? "bg-emerald-950/40 text-emerald-400" : "bg-[var(--ide-surface)] text-[var(--ide-muted)]"
                }`}>
                  {status ? "Ready" : "Empty"}
                </span>
              )}
              <ChevronRight className="h-3.5 w-3.5 text-[var(--ide-muted)] shrink-0" />
            </button>
          ))}
        </div>

      </div>

      {/* Modals */}
      {openModal === "docs" && (
        <DocsModal projectId={projectId} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "code" && (
        <CodeModal projectId={projectId} gitlabConfig={selectedProject?.gitlab_config} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "figma" && (
        <FigmaModal projectId={projectId} onClose={() => setOpenModal(null)} />
      )}
    </div>
  );
}

export default AllContextPanel;
