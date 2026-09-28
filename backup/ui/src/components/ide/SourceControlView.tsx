"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GitBranch, RefreshCw, ArrowDown, ArrowUp, Check,
  FileCode2, FilePlus2, FileX2, Loader2, Plus, Minus,
  AlertCircle, FolderKanban,
} from "lucide-react";
import {
  getWorkspaceGitStatus,
  commitChanges,
  pullChanges,
  pushChanges,
  stageFile,
  unstageFile,
  type GitStatus,
  type ChangedFile,
  type FileChangeStatus,
} from "@/lib/git-workspace-api";
import { useGlobalProject } from "@/providers/ProjectProvider";

const STATUS_ICON: Record<FileChangeStatus, { Icon: typeof FileCode2; color: string; label: string }> = {
  modified: { Icon: FileCode2, color: "text-amber-400", label: "M" },
  added:    { Icon: FilePlus2, color: "text-emerald-400", label: "A" },
  deleted:  { Icon: FileX2,   color: "text-red-400",     label: "D" },
  renamed:  { Icon: FileCode2, color: "text-blue-400",   label: "R" },
};

export function SourceControlView({
  workspaceId,
  onOpenFile,
}: {
  workspaceId: number;
  onOpenFile?: (path: string) => void;
}) {
  const { selectedProjectId, selectedProject } = useGlobalProject();
  const [status, setStatus]       = useState<GitStatus | null>(null);
  const [loading, setLoading]     = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const [syncing, setSyncing]     = useState<"pull" | "push" | "commit" | null>(null);
  const [feedback, setFeedback]   = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!selectedProjectId) { setStatus(null); setLoading(false); return; }
    setLoading(true);
    try {
      const s = await getWorkspaceGitStatus(selectedProjectId);
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const showFeedback = (text: string, ok: boolean) => {
    setFeedback({ text, ok });
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleStage = async (path: string) => {
    await stageFile(selectedProjectId, path);
    setStatus((prev) =>
      prev ? { ...prev, changes: prev.changes.map((c) => c.path === path ? { ...c, staged: true } : c) } : prev,
    );
  };

  const handleUnstage = async (path: string) => {
    await unstageFile(selectedProjectId, path);
    setStatus((prev) =>
      prev ? { ...prev, changes: prev.changes.map((c) => c.path === path ? { ...c, staged: false } : c) } : prev,
    );
  };

  const handleCommit = async () => {
    if (!commitMsg.trim() || !selectedProjectId) return;
    setSyncing("commit");
    try {
      const res = await commitChanges(selectedProjectId, commitMsg.trim());
      showFeedback(res.message || `Committed successfully`, res.success);
      setCommitMsg("");
      await refresh();
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : "Commit failed", false);
    } finally {
      setSyncing(null);
    }
  };

  const handlePull = async () => {
    if (!selectedProjectId) return;
    setSyncing("pull");
    try {
      const res = await pullChanges(selectedProjectId);
      showFeedback(res.message, res.success);
      await refresh();
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : "Pull failed", false);
    } finally {
      setSyncing(null);
    }
  };

  const handlePush = async () => {
    if (!selectedProjectId) return;
    setSyncing("push");
    try {
      const res = await pushChanges(selectedProjectId);
      showFeedback(res.message, res.success);
      await refresh();
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : "Push failed", false);
    } finally {
      setSyncing(null);
    }
  };

  /* ── No project selected ─────────────────────────────────────────── */
  if (!selectedProjectId) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-[var(--ide-muted)] gap-2 px-3">
        <FolderKanban className="h-6 w-6 opacity-40" />
        <p className="text-[11px] text-center">No project selected.<br />Select a project from the main app header.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--ide-muted)]">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-[11px]">Loading…</span>
      </div>
    );
  }

  /* ── Not configured ──────────────────────────────────────────────── */
  if (!status || !status.configured) {
    return (
      <div className="px-3 py-4 text-center space-y-2">
        <GitBranch className="h-6 w-6 text-[var(--ide-muted)] mx-auto opacity-40" />
        <p className="text-[11px] text-[var(--ide-muted)]">
          No Git repository configured for <strong className="text-[var(--ide-text)]">{selectedProject?.name}</strong>.
        </p>
        <p className="text-[10px] text-[var(--ide-muted)]">
          Use the Source Connector to clone a repo, or configure Git in Project Settings.
        </p>
      </div>
    );
  }

  /* ── No local clone yet ──────────────────────────────────────────── */
  if (!status.hasRepo) {
    return (
      <div className="px-3 py-4 text-center space-y-3">
        <GitBranch className="h-6 w-6 text-violet-400 mx-auto opacity-60" />
        <p className="text-[11px] text-[var(--ide-text)]">Repository connected</p>
        {status.repoUrl && (
          <p className="text-[10px] text-[var(--ide-muted)] truncate">{status.repoUrl}</p>
        )}
        <p className="text-[10px] text-[var(--ide-muted)]">No local clone yet. Click Pull to download.</p>
        <button type="button" onClick={handlePull} disabled={syncing !== null}
          className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-40 text-[11px] font-medium text-white transition-all">
          {syncing === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDown className="h-3.5 w-3.5" />}
          Pull & Clone
        </button>
        {feedback && (
          <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] ${
            feedback.ok ? "bg-emerald-950/30 border border-emerald-800/40 text-emerald-300"
              : "bg-red-950/30 border border-red-500/30 text-red-300"
          }`}>
            {feedback.ok ? <Check className="h-3 w-3 shrink-0" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
            {feedback.text}
          </div>
        )}
      </div>
    );
  }

  const staged = status.changes.filter((c) => c.staged);
  const unstaged = status.changes.filter((c) => !c.staged);

  return (
    <div className="flex flex-col h-full text-[var(--ide-text)]">

      {/* Branch + sync info */}
      <div className="shrink-0 px-3 py-2 border-b border-[var(--ide-border)] space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <GitBranch className="h-3.5 w-3.5 text-violet-400 shrink-0" />
            <span className="text-xs font-medium truncate">{status.branch}</span>
          </div>
          <button type="button" onClick={refresh} title="Refresh"
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>

        {/* Repo URL */}
        {status.repoUrl && (
          <p className="text-[10px] text-[var(--ide-muted)] truncate">{status.repoUrl}</p>
        )}

        {/* Ahead / behind */}
        {status.hasRemote && (status.ahead > 0 || status.behind > 0) && (
          <div className="flex items-center gap-3 text-[10px] text-[var(--ide-muted)]">
            {status.ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUp className="h-2.5 w-2.5" /> {status.ahead} ahead
              </span>
            )}
            {status.behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDown className="h-2.5 w-2.5" /> {status.behind} behind
              </span>
            )}
          </div>
        )}

        {/* Pull / Push buttons */}
        <div className="flex gap-1.5">
          <button type="button" onClick={handlePull}
            disabled={syncing !== null}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-md border border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] disabled:opacity-40 transition-colors"
          >
            {syncing === "pull" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDown className="h-3 w-3" />}
            Pull
          </button>
          <button type="button" onClick={handlePush}
            disabled={syncing !== null}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-md border border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] disabled:opacity-40 transition-colors"
          >
            {syncing === "push" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
            Push
          </button>
        </div>
      </div>

      {/* Commit section */}
      <div className="shrink-0 px-3 py-2 border-b border-[var(--ide-border)] space-y-1.5">
        <textarea
          rows={2}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message…"
          className="w-full resize-none rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2 py-1.5 text-[11px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
        <button type="button" onClick={handleCommit}
          disabled={!commitMsg.trim() || syncing !== null}
          className="w-full inline-flex items-center justify-center gap-1 h-7 rounded-md bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-40 text-[11px] font-medium text-white transition-all"
        >
          {syncing === "commit"
            ? <><Loader2 className="h-3 w-3 animate-spin" /> Committing & Pushing…</>
            : <><Check className="h-3 w-3" /> Commit & Push</>}
        </button>
        <p className="text-[9px] text-[var(--ide-muted)]">
          Commits all changes and pushes to remote.
        </p>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className={`shrink-0 mx-3 mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] ${
          feedback.ok
            ? "bg-emerald-950/30 border border-emerald-800/40 text-emerald-300"
            : "bg-red-950/30 border border-red-500/30 text-red-300"
        }`}>
          {feedback.ok ? <Check className="h-3 w-3 shrink-0" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
          {feedback.text}
        </div>
      )}

      {/* Changed files list */}
      <div className="flex-1 min-h-0 overflow-y-auto">

        {/* Staged changes */}
        {staged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">
              <span>Staged ({staged.length})</span>
            </div>
            {staged.map((f) => (
              <FileRow key={f.path} file={f} onOpenFile={onOpenFile}
                action={<button type="button" title="Unstage" onClick={() => handleUnstage(f.path)}
                  className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
                  <Minus className="h-2.5 w-2.5" />
                </button>}
              />
            ))}
          </div>
        )}

        {/* Unstaged changes */}
        {unstaged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">
              <span>Changes ({unstaged.length})</span>
            </div>
            {unstaged.map((f) => (
              <FileRow key={f.path} file={f} onOpenFile={onOpenFile}
                action={<button type="button" title="Stage" onClick={() => handleStage(f.path)}
                  className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
                  <Plus className="h-2.5 w-2.5" />
                </button>}
              />
            ))}
          </div>
        )}

        {/* No changes */}
        {status.changes.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--ide-muted)]">
            No changes detected
          </div>
        )}
      </div>
    </div>
  );
}

/* ── File row ─────────────────────────────────────────────────────────── */
function FileRow({
  file,
  onOpenFile,
  action,
}: {
  file: ChangedFile;
  onOpenFile?: (path: string) => void;
  action: React.ReactNode;
}) {
  const baseName = file.path.split("/").pop() ?? file.path;
  const dir = file.path.split("/").slice(0, -1).join("/");
  const si = STATUS_ICON[file.status];

  return (
    <div className="group flex items-center gap-1 px-3 py-0.5 hover:bg-[var(--ide-hover)] transition-colors">
      <button type="button" onClick={() => onOpenFile?.(file.path)}
        className="flex-1 flex items-center gap-1.5 min-w-0 text-left">
        <si.Icon className={`h-3 w-3 shrink-0 ${si.color}`} />
        <span className="text-[11px] text-[var(--ide-text)] truncate">{baseName}</span>
        {dir && <span className="text-[10px] text-[var(--ide-muted)] truncate">{dir}</span>}
      </button>
      <span className={`text-[9px] font-mono font-bold shrink-0 ${si.color}`}>{si.label}</span>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {action}
      </div>
    </div>
  );
}

export default SourceControlView;
