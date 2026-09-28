"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  GitBranch,
  GitCommit,
  Loader2,
  RefreshCw,
  FolderOpen,
  ArrowDown,
  ArrowUp,
  Check,
  AlertCircle,
  AlertTriangle,
  Shield,
  X,
} from "lucide-react";
import {
  getGitStatus,
  getGitBranches,
  gitPull,
  gitPush,
  saveGitRepo,
  previewGitRepoFiles,
  type GitStatusResult,
  type GitProviderInfo,
} from "@/lib/legacy-modernization-api";

/* ── Provider display helpers ─────────────────────────────────────────── */

function providerLabel(p: string) {
  switch (p) {
    case "azure_devops": return "Azure DevOps";
    case "github": return "GitHub";
    case "gitlab": return "GitLab";
    default: return p;
  }
}

/* ── Main Component ───────────────────────────────────────────────────── */

interface SourceControlPanelProps {
  projectId?: number | null;
  onPullSuccess?: (provider?: string) => void;
  onRepoAvailable?: (provider?: string) => void;
  onPreviewLoaded?: (payload: { tree: Array<Record<string, unknown>>; count: number; provider?: string; branch?: string }) => void;
}

export default function SourceControlPanel({ projectId, onPullSuccess, onRepoAvailable, onPreviewLoaded }: SourceControlPanelProps) {
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [currentBranch, setCurrentBranch] = useState("main");
  const [customBranch, setCustomBranch] = useState("");
  const [useCustomPushBranch, setUseCustomPushBranch] = useState(false);
  const [customPushBranchName, setCustomPushBranchName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(undefined);
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [opResult, setOpResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  // Repo URL save state (for providers that need a repo URL)
  const [repoUrlInput, setRepoUrlInput] = useState("");
  const [savingRepoUrl, setSavingRepoUrl] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewApproved, setPreviewApproved] = useState(false);
  // Which provider actually "owns" the current .devaccel clone
  const [clonedProvider, setClonedProvider] = useState<string | null>(null);
  const [pushConfirm, setPushConfirm] = useState(false);

  const clearOpResult = useCallback(() => {
    setTimeout(() => setOpResult(null), 5000);
  }, []);

  const loadBranches = useCallback(async (prov?: string) => {
    if (!projectId) return;
    setBranchesLoading(true);
    try {
      const data = await getGitBranches(projectId, prov || selectedProvider);
      setBranches(data.branches || []);
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }, [projectId, selectedProvider]);

  const loadStatus = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await getGitStatus(projectId, selectedProvider);
      setGitStatus(data);
      setCurrentBranch(data.branch || data.default_branch || "main");
      setClonedProvider(data.cloned_provider ?? null);
      if (data.has_repo) {
        onRepoAvailable?.(selectedProvider || data.provider || undefined);
      }
      // auto-select provider from response if not yet chosen
      if (!selectedProvider && data.provider) {
        setSelectedProvider(data.provider);
      }
    } catch {
      // API unreachable — treat as not configured
      setGitStatus({ configured: false, has_repo: false, branch: "unknown" });
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedProvider, onRepoAvailable]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Load branches when provider or project changes
  useEffect(() => {
    if (projectId && selectedProvider) {
      loadBranches(selectedProvider);
    }
  }, [projectId, selectedProvider, loadBranches]);

  const handlePull = async () => {
    if (!projectId) return;
    setPullLoading(true);
    setOpResult(null);
    try {
      const branch = customBranch.trim() || undefined;
      const result = await gitPull(projectId, branch, selectedProvider);
      setOpResult({ type: "success", message: result.message });
      clearOpResult();
      setPreviewApproved(false);
      await loadStatus();
      // Reload branches from this provider after pull
      loadBranches(selectedProvider);
      onPullSuccess?.(selectedProvider);
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Pull failed" });
      clearOpResult();
    } finally {
      setPullLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!projectId) return;
    setPreviewLoading(true);
    setOpResult(null);
    try {
      const branch = customBranch.trim() || undefined;
      const preview = await previewGitRepoFiles(projectId, selectedProvider, branch);
      onPreviewLoaded?.({
        tree: (preview?.tree as Array<Record<string, unknown>>) ?? [],
        count: preview?.count || 0,
        provider: selectedProvider,
        branch: preview?.branch || branch,
      });
      setPreviewApproved(true);
      const suffix = preview?.truncated ? " (preview truncated)" : "";
      setOpResult({
        type: "success",
        message: `Loaded preview: ${preview?.count || 0} files${suffix}. Open Explorer to review before pull.`,
      });
      clearOpResult();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Preview failed" });
      clearOpResult();
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePush = async () => {
    if (!projectId) return;
    setPushConfirm(false);
    setPushLoading(true);
    setOpResult(null);
    try {
      const branch = useCustomPushBranch
        ? (customPushBranchName.trim() || undefined)
        : (customBranch.trim() || undefined);
      const result = await gitPush(
        projectId,
        branch,
        commitMessage.trim() || undefined,
        selectedProvider,
      );
      setOpResult({ type: "success", message: result.message });
      clearOpResult();
      setCommitMessage("");
      await loadStatus();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Push failed" });
      clearOpResult();
    } finally {
      setPushLoading(false);
    }
  };

  const isConfigured = gitStatus?.configured ?? false;
  const hasRepo = gitStatus?.has_repo ?? false;
  const providers: GitProviderInfo[] = gitStatus?.providers || [];

  useEffect(() => {
    if (!providers.length) return;
    if (!selectedProvider || !providers.some((p) => p.provider === selectedProvider)) {
      setSelectedProvider(providers[0].provider);
    }
  }, [providers, selectedProvider]);

  useEffect(() => {
    setPreviewApproved(false);
  }, [projectId, selectedProvider, customBranch]);

  const handleProviderChange = (prov: string) => {
    setSelectedProvider(prov);
    setRepoUrlInput("");
    setCustomBranch("");
    setBranches([]);
    // re-load status for the new provider
    (async () => {
      setLoading(true);
      try {
        const data = await getGitStatus(projectId!, prov);
        setGitStatus(data);
        setCurrentBranch(data.branch || data.default_branch || "main");
        setClonedProvider(data.cloned_provider ?? null);
        if (data.has_repo) {
          onRepoAvailable?.(prov);
        }
      } catch {
        setGitStatus({ configured: false, has_repo: false, branch: "unknown" });
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleSaveRepoUrl = async () => {
    if (!projectId || !selectedProvider || !repoUrlInput.trim()) return;
    setSavingRepoUrl(true);
    setOpResult(null);
    try {
      await saveGitRepo(projectId, selectedProvider, repoUrlInput.trim());
      setOpResult({ type: "success", message: "Repository URL saved" });
      clearOpResult();
      setRepoUrlInput("");
      await loadStatus();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Failed to save repo URL" });
      clearOpResult();
    } finally {
      setSavingRepoUrl(false);
    }
  };

  const runContextPull = async (provider: string) => {
    if (!projectId) return;
    setPullLoading(true);
    setOpResult(null);
    try {
      const branch = customBranch.trim() || undefined;
      const result = await gitPull(projectId, branch, provider);
      setOpResult({ type: "success", message: result.message });
      clearOpResult();
      await loadStatus();
      loadBranches(provider);
      onPullSuccess?.(provider);
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Pull failed" });
      clearOpResult();
    } finally {
      setPullLoading(false);
    }
  };

  const runContextPush = async (provider: string) => {
    if (!projectId) return;
    setPushLoading(true);
    setOpResult(null);
    try {
      const branch = customBranch.trim() || undefined;
      const result = await gitPush(
        projectId,
        branch,
        commitMessage.trim() || undefined,
        provider,
      );
      setOpResult({ type: "success", message: result.message });
      clearOpResult();
      setCommitMessage("");
      await loadStatus();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Push failed" });
      clearOpResult();
    } finally {
      setPushLoading(false);
    }
  };

  // Check if the currently selected provider needs a repo URL
  const activeProviderNeedsRepo = providers.find(
    (p) => p.provider === (selectedProvider || gitStatus?.provider)
  )?.needs_repo_url ?? false;

  const activeProviderLabel = selectedProvider
    ? providerLabel(selectedProvider)
    : gitStatus?.provider
      ? providerLabel(gitStatus.provider)
      : "Select Provider";

  // Whether the currently-selected provider is the one that owns the clone
  const isActiveProvider = !clonedProvider || clonedProvider === selectedProvider;
  const clonedProviderLabel = clonedProvider ? providerLabel(clonedProvider) : null;

  return (
    <div
      className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden"
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 min-w-[210px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md cbv2-card-elevated cbv2-animate-scale-in"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-cbv2-text-dim font-semibold">
              Source Control
            </div>
            {providers.length === 0 && (
              <div className="px-3 py-1.5 text-[11px] text-cbv2-text-dim">
                No source control configured
              </div>
            )}
            {providers.map((p) => (
              <React.Fragment key={`scctx-${p.provider}`}>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors disabled:opacity-40"
                  onClick={() => {
                    setContextMenu(null);
                    runContextPull(p.provider);
                  }}
                  disabled={pullLoading || pushLoading || !projectId || !!p.needs_repo_url}
                  title={`Pull from ${providerLabel(p.provider)}${customBranch ? ` (${customBranch})` : ""}`}
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                  Pull ({providerLabel(p.provider)})
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors disabled:opacity-40"
                  onClick={() => {
                    setContextMenu(null);
                    runContextPush(p.provider);
                  }}
                  disabled={pullLoading || pushLoading || !projectId || !!p.needs_repo_url || (!!clonedProvider && clonedProvider !== p.provider)}
                  title={
                    clonedProvider && clonedProvider !== p.provider
                      ? `Cannot push — workspace cloned from ${providerLabel(clonedProvider)}`
                      : `Push to ${providerLabel(p.provider)}${customBranch ? ` (${customBranch})` : ""}`
                  }
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                  Push ({providerLabel(p.provider)})
                </button>
                {p.needs_repo_url && (
                  <div className="px-3 pb-1.5 text-[10px] text-yellow-400">
                    {providerLabel(p.provider)} repo URL required in settings
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </>
      )}
      {/* Push Confirmation Dialog */}
      {pushConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setPushConfirm(false)}>
          <div className="w-[320px] bg-cbv2-sidebar border border-cbv2-border rounded-lg cbv2-card-elevated cbv2-animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Confirm Push</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text leading-relaxed">
                You are about to push changes to <span className="text-cbv2-accent font-medium">{activeProviderLabel}</span>
                {customBranch ? ` (branch: ${customBranch})` : ` (branch: ${currentBranch})`}.
              </p>
              {commitMessage.trim() && (
                <p className="text-[10px] text-cbv2-text-dim mt-2 bg-cbv2-input rounded px-2 py-1 font-mono truncate">
                  &quot;{commitMessage.trim()}&quot;
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => setPushConfirm(false)}>Cancel</button>
              <button className="h-7 px-4 rounded bg-cbv2-accent text-[11px] text-white hover:bg-cbv2-accent/80 transition-colors flex items-center gap-1.5" onClick={handlePush}>
                <ArrowUp className="w-3.5 h-3.5" />
                Push
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="px-4 py-2.5 border-b border-cbv2-border flex items-center justify-between shrink-0 cbv2-header-gradient">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-cbv2-accent/15 flex items-center justify-center">
            <GitBranch className="w-4 h-4 text-cbv2-accent" />
          </div>
          <div>
            <span className="text-[12px] font-semibold block">Source Control</span>
            {isConfigured && hasRepo && isActiveProvider && (
              <span className="text-[10px] text-cbv2-text-dim flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                {currentBranch}
              </span>
            )}
          </div>
        </div>
        <button
          className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
          onClick={() => { loadStatus(); }}
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Provider selector */}
      {projectId && providers.length > 0 && (
        <div className="px-4 py-2 border-b border-cbv2-border">
          <div className="flex flex-wrap gap-1.5">
            {providers.map((p) => (
              <button
                key={p.provider}
                className={`h-7 rounded border px-2 text-[11px] transition-colors flex items-center gap-1 ${
                  selectedProvider === p.provider
                    ? "border-cbv2-accent text-cbv2-accent bg-cbv2-accent/10"
                    : "border-cbv2-border text-cbv2-text hover:bg-cbv2-hover"
                }`}
                onClick={() => handleProviderChange(p.provider)}
                title={providerLabel(p.provider)}
              >
                {clonedProvider === p.provider && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="Active clone" />
                )}
                {providerLabel(p.provider)}
                {p.needs_repo_url ? " *" : ""}
              </button>
            ))}
          </div>
          {gitStatus?.repo_url && isActiveProvider && (
            <p className="text-[10px] text-cbv2-text-dim mt-1 truncate" title={gitStatus.repo_url}>
              {gitStatus.repo_url}
            </p>
          )}
        </div>
      )}

      {/* Not configured state */}
      {!projectId ? (
        <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim flex-1">
          <FolderOpen className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-[11px]">No project selected.</p>
          <p className="text-[10px] mt-1">Select a project to use Source Control.</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim flex-1">
          <Loader2 className="w-6 h-6 animate-spin mb-2 opacity-40" />
          <p className="text-[11px]">Checking git configuration…</p>
        </div>
      ) : !isConfigured ? (
        <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim flex-1 px-4">
          <GitBranch className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-[11px] text-center">No source control configured.</p>
          <p className="text-[10px] mt-1 text-center">
            Configure <span className="text-cbv2-accent">GitHub</span> or <span className="text-cbv2-accent">Azure DevOps</span> in Project Settings.
          </p>
        </div>
      ) : activeProviderNeedsRepo ? (
        <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim flex-1 px-4 space-y-3">
          <AlertCircle className="w-8 h-8 mb-1 text-yellow-400 opacity-60" />
          <p className="text-[11px] text-center text-cbv2-text">
            {activeProviderLabel} needs a repository URL
          </p>
          <p className="text-[10px] text-center leading-relaxed max-w-[220px]">
            Enter the Git repository URL for <span className="text-cbv2-accent">{activeProviderLabel}</span> to enable source control.
          </p>
          <div className="space-y-1.5 w-full px-2">
            <input
              type="url"
              placeholder={selectedProvider === "azure_devops"
                ? "https://dev.azure.com/org/project/_git/repo"
                : "https://github.com/org/repo.git"}
              value={repoUrlInput}
              onChange={(e) => setRepoUrlInput(e.target.value)}
              className="w-full h-7 rounded border border-cbv2-border bg-cbv2-input px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim focus:outline-none focus:ring-1 focus:ring-cbv2-accent"
            />
            <button
              className="w-full flex items-center justify-center gap-1.5 h-8 rounded bg-cbv2-accent text-[11px] text-white hover:bg-cbv2-accent/80 disabled:opacity-40 transition-colors"
              onClick={handleSaveRepoUrl}
              disabled={savingRepoUrl || !repoUrlInput.trim()}
            >
              {savingRepoUrl ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Save Repository URL
            </button>
          </div>
          {opResult && (
            <div
              className={`w-full flex items-start gap-2 rounded-md border p-2 text-[11px] ${
                opResult.type === "success"
                  ? "border-green-800 bg-green-950/30 text-green-300"
                  : "border-red-800 bg-red-950/30 text-red-300"
              }`}
            >
              {opResult.type === "success" ? (
                <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              <span className="break-all">{opResult.message}</span>
            </div>
          )}
        </div>
      ) : !hasRepo ? (
        <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim flex-1 px-4 space-y-3">
          <GitBranch className="w-8 h-8 mb-1 text-cbv2-accent opacity-60" />
          <p className="text-[11px] text-center text-cbv2-text">
            {activeProviderLabel} repo connected
          </p>
          <p className="text-[10px] text-center leading-relaxed max-w-[220px]">
            No local clone yet. Click <span className="text-cbv2-accent">Pull</span> to download the repository.
          </p>
          <div className="space-y-1.5 w-full px-2">
            <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide font-medium">
              Select Branch
            </label>
            <div className="relative">
              <select
                value={customBranch}
                onChange={(e) => setCustomBranch(e.target.value)}
                className="w-full h-7 rounded border border-cbv2-border bg-cbv2-input px-2 text-[11px] text-cbv2-text focus:outline-none focus:ring-1 focus:ring-cbv2-accent appearance-none pr-6"
              >
                <option value="">{gitStatus?.default_branch || "main"} (default)</option>
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              {branchesLoading && (
                <Loader2 className="absolute right-1.5 top-1.5 w-3.5 h-3.5 animate-spin text-cbv2-text-dim" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="w-full flex items-center justify-center gap-1.5 h-8 rounded border border-cbv2-border bg-cbv2-input text-[11px] text-cbv2-text hover:bg-cbv2-hover disabled:opacity-40 transition-colors"
                onClick={handlePreview}
                disabled={previewLoading || pullLoading}
              >
                {previewLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="w-3.5 h-3.5" />
                )}
                Preview Files
              </button>
              <button
                className="w-full flex items-center justify-center gap-1.5 h-8 rounded bg-cbv2-accent text-[11px] text-white hover:bg-cbv2-accent/80 disabled:opacity-40 transition-colors"
                onClick={handlePull}
                disabled={pullLoading || previewLoading || !previewApproved}
                title={previewApproved ? "Approve preview and ingest into DevAccel" : "Preview files first, then approve ingest"}
              >
              {pullLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowDown className="w-3.5 h-3.5" />
              )}
              Approve &amp; Pull
              </button>
            </div>
            {!previewApproved && (
              <p className="text-[10px] text-cbv2-text-dim">
                Step 1: Preview files. Step 2: Approve &amp; Pull to ingest for modernization.
              </p>
            )}
          </div>
          {opResult && (
            <div
              className={`w-full flex items-start gap-2 rounded-md border p-2 text-[11px] ${
                opResult.type === "success"
                  ? "border-green-800 bg-green-950/30 text-green-300"
                  : "border-red-800 bg-red-950/30 text-red-300"
              }`}
            >
              {opResult.type === "success" ? (
                <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              <span className="break-all">{opResult.message}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto cbv2-scrollbar">
          {/* Non-active provider banner */}
          {!isActiveProvider && clonedProviderLabel && (
            <div className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-yellow-800 bg-yellow-950/30 p-2 text-[11px] text-yellow-300">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Workspace is currently cloned from <strong>{clonedProviderLabel}</strong>.
                Pull from {activeProviderLabel} to switch.
              </span>
            </div>
          )}

          {/* Branch info + Pull / Push */}
          <div className="px-4 py-2 border-b border-cbv2-border space-y-2">
            {isActiveProvider && (
              <div className="flex items-center gap-2 text-[11px]">
                <GitCommit className="w-3.5 h-3.5 text-cbv2-text-dim" />
                <span className="text-cbv2-accent">{currentBranch}</span>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide font-medium">
                Branch
              </label>

              {/* Toggle: select existing vs new branch (push only, active provider) */}
              {isActiveProvider && (
                <div className="flex items-center gap-2 mb-1">
                  <button
                    className={`h-6 px-2 rounded text-[10px] transition-colors ${
                      !useCustomPushBranch
                        ? "bg-cbv2-accent/20 text-cbv2-accent border border-cbv2-accent"
                        : "bg-transparent text-cbv2-text-dim border border-cbv2-border hover:bg-cbv2-hover"
                    }`}
                    onClick={() => setUseCustomPushBranch(false)}
                  >
                    Select Existing
                  </button>
                  <button
                    className={`h-6 px-2 rounded text-[10px] transition-colors ${
                      useCustomPushBranch
                        ? "bg-cbv2-accent/20 text-cbv2-accent border border-cbv2-accent"
                        : "bg-transparent text-cbv2-text-dim border border-cbv2-border hover:bg-cbv2-hover"
                    }`}
                    onClick={() => setUseCustomPushBranch(true)}
                  >
                    New Branch
                  </button>
                </div>
              )}

              {/* Dropdown for existing branches */}
              {!useCustomPushBranch && (
              <div className="relative">
                <select
                  value={customBranch}
                  onChange={(e) => setCustomBranch(e.target.value)}
                  className="w-full h-7 rounded border border-cbv2-border bg-cbv2-input px-2 text-[11px] text-cbv2-text focus:outline-none focus:ring-1 focus:ring-cbv2-accent appearance-none pr-6"
                >
                  {isActiveProvider ? (
                    <option value="">{currentBranch || "main"} (current)</option>
                  ) : (
                    <option value="">{gitStatus?.default_branch || "main"} (default)</option>
                  )}
                  {branches
                    .filter((b) => isActiveProvider ? b !== currentBranch : b !== (gitStatus?.default_branch || "main"))
                    .map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                </select>
                {branchesLoading && (
                  <Loader2 className="absolute right-1.5 top-1.5 w-3.5 h-3.5 animate-spin text-cbv2-text-dim" />
                )}
              </div>
              )}

              {/* Text input for new branch name */}
              {useCustomPushBranch && isActiveProvider && (
                <input
                  type="text"
                  placeholder="feature/my-new-branch"
                  value={customPushBranchName}
                  onChange={(e) => setCustomPushBranchName(e.target.value)}
                  className="w-full h-7 rounded border border-cbv2-border bg-cbv2-input px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim focus:outline-none focus:ring-1 focus:ring-cbv2-accent"
                  autoFocus
                />
              )}
            </div>

            {/* Commit message for push (only when this is the active provider) */}

            {/* Pull / Push buttons */}
            <div className="flex gap-2">
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded border text-[11px] transition-colors disabled:opacity-40 ${
                  !isActiveProvider
                    ? "border-cbv2-accent bg-cbv2-accent text-white hover:bg-cbv2-accent/80"
                    : "border-cbv2-border bg-cbv2-input text-cbv2-text hover:bg-cbv2-hover hover:text-white"
                }`}
                onClick={handlePull}
                disabled={pullLoading || pushLoading}
                title={isActiveProvider ? "Pull from remote" : `Pull from ${activeProviderLabel} (will switch workspace)`}
              >
                {pullLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowDown className="w-3.5 h-3.5" />
                )}
                {isActiveProvider ? "Pull" : `Pull from ${activeProviderLabel}`}
              </button>
              {isActiveProvider && (
                <button
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded bg-cbv2-accent text-[11px] text-white hover:bg-cbv2-accent/80 disabled:opacity-40 transition-colors"
                  onClick={() => setPushConfirm(true)}
                  disabled={pullLoading || pushLoading}
                  title="Push to remote"
                >
                  {pushLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="w-3.5 h-3.5" />
                  )}
                  Push
                </button>
              )}
            </div>

            {/* Commit message — push only */}
            {isActiveProvider && (
              <div className="space-y-1 pt-1 border-t border-cbv2-border/50">
                <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wide font-medium">
                  Commit Message (for Push)
                </label>
                <input
                  type="text"
                  placeholder={`DevAccel: code update ${new Date().toISOString().slice(0, 10)}`}
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="w-full h-7 rounded border border-cbv2-border bg-cbv2-input px-2 text-[11px] text-cbv2-text placeholder:text-cbv2-text-dim focus:outline-none focus:ring-1 focus:ring-cbv2-accent"
                />
              </div>
            )}
          </div>

          {/* Operation result feedback */}
          {opResult && (
            <div
              className={`mx-4 mt-2 flex items-start gap-2 rounded-md border p-2 text-[11px] ${
                opResult.type === "success"
                  ? "border-green-800 bg-green-950/30 text-green-300"
                  : "border-red-800 bg-red-950/30 text-red-300"
              }`}
            >
              {opResult.type === "success" ? (
                <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              <span className="break-words">{opResult.message}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
