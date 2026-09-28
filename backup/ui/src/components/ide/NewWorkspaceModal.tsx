"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  X, FolderGit2, Loader2, FolderOpen, CheckCircle2,
  HardDriveDownload, MapPin, GitBranch, Upload, Key, Globe,
} from "lucide-react";
import {
  createLocalWorkspace,
  replaceNodes,
  getAllNodes,
  getFile,
} from "@/lib/db/workspaceStore";
import { WorkspaceUploadZone } from "@/components/ide/WorkspaceUploadZone";
import {
  isFsApiAvailable,
  pickDirectory,
  storeDirectoryHandle,
  cacheHandle,
  scanDirectory,
  writeFsFile,
} from "@/lib/localFs";
import {
  getCapability,
  openAgentRoot,
  fromHandle,
  setWorkspaceFileAccess,
  agentClient,
  type FileAccess,
} from "@/lib/fileAccess";
import { Server } from "lucide-react";
import {
  detectProvider,
  extractRepoName,
  listBranches,
  cloneRepo,
  PROVIDER_INFO,
  type GitProvider,
} from "@/lib/git-clone-api";
import { writeSpecFilesToWorkspace } from "@/lib/spec-workspace-writer";
import type { SpecSubtaskOutput } from "@/lib/spec-api";
import { createWorkspace } from "@/lib/workspace-api";

type SourceTab = "local" | "upload" | "git";

/** Message shown inline when the Full Path is missing or not a real absolute path. */
const FULL_PATH_REQUIRED_MSG =
  "Full Path is required to create a workspace. Please provide a valid Full Path and try again.";

/**
 * Strip wrapping quotes. Windows "Copy as path" yields `"C:\...\folder"` (with
 * literal double quotes), which would otherwise fail the absolute-path check.
 */
const stripQuotes = (p: string): string => p.replace(/^["']+|["']+$/g, "");

/**
 * A real absolute path: Windows drive (C:\ or C:/), POSIX root (/…), or UNC (\\…).
 * The pre-filled folder *name* alone (browser can't read the real path) is not valid,
 * so the user is forced to paste the actual full path.
 */
const isValidFullPath = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || /^\\\\/.test(p);

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewWorkspaceModal({ open, onClose }: Props) {
  const router = useRouter();
  const pathInputRef = useRef<HTMLInputElement>(null);

  const [wsId,          setWsId]          = useState<number>(() => Date.now());
  const [name,          setName]          = useState("");
  const [description,   setDescription]   = useState("");
  const [localPathLabel, setLocalPathLabel] = useState("");
  const [uploadedCount,  setUploadedCount]  = useState<number | null>(null);
  const [saving,         setSaving]         = useState(false);
  const [nameError,      setNameError]      = useState("");
  const [pathError,      setPathError]      = useState("");
  const [pickedHandle,   setPickedHandle]   = useState<FileSystemDirectoryHandle | null>(null);
  const [scanning,       setScanning]       = useState(false);
  const [extracting,     setExtracting]     = useState(false);
  // Local-file capability: daemon on 127.0.0.1 (works over HTTP) and/or the
  // browser File System Access API (needs HTTPS/localhost).
  const [cap,            setCap]            = useState<{ agent: boolean; fsApi: boolean }>({ agent: false, fsApi: false });
  const [agentAccess,    setAgentAccess]    = useState<FileAccess | null>(null);
  const [agentPath,      setAgentPath]      = useState("");
  const [browsing,       setBrowsing]       = useState(false);
  const fsAvailable = cap.fsApi;

  /* Source tab */
  const [sourceTab, setSourceTab] = useState<SourceTab>("local");

  /* Git clone state */
  const [repoUrl,    setRepoUrl]    = useState("");
  const [gitProvider,setGitProvider]= useState<GitProvider>("github");
  const [branch,     setBranch]     = useState("main");
  const [branches,   setBranches]   = useState<string[]>([]);
  const [patToken,   setPatToken]   = useState("");
  const [cloning,    setCloning]    = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Detect local-file transports when the modal opens: the daemon (preferred,
  // works over HTTP) and/or the browser FS API (HTTPS/localhost). Re-check on
  // window focus so it connects right after the user starts the daemon.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const detect = async () => {
      const c = await getCapability().catch(() => ({ agent: isFsApiAvailable() ? false : false, fsApi: isFsApiAvailable() }));
      if (!cancelled) setCap({ agent: c.agent, fsApi: c.fsApi });
    };
    void detect();
    const onFocus = () => { void detect(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, [open]);

  useEffect(() => {
    if (open) {
      setWsId(Date.now());
      setName(""); setDescription(""); setLocalPathLabel("");
      setUploadedCount(null); setSaving(false); setNameError(""); setPathError("");
      setPickedHandle(null); setScanning(false); setExtracting(false);
      setAgentAccess(null); setAgentPath(""); setBrowsing(false);
      setSourceTab("local"); setRepoUrl(""); setGitProvider("github");
      setBranch("main"); setBranches([]); setPatToken("");
      setCloning(false); setCloneError(""); setLoadingBranches(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  /* Focus the path input whenever a folder is first linked */
  useEffect(() => {
    if (pickedHandle) {
      // Small delay so the input is rendered before focus
      setTimeout(() => pathInputRef.current?.focus(), 50);
    }
  }, [pickedHandle]);

  /* ── Link an existing local folder ──────────────────────────────────── */
  const handlePickFolder = async () => {
    try {
      const handle = await pickDirectory();
      setPickedHandle(handle);
      cacheHandle(wsId, handle);
      // Pre-fill with just the folder name; user completes the full path
      setLocalPathLabel(handle.name);
      if (!name) setName(handle.name);
      setScanning(true);
      const nodes = await scanDirectory(handle);
      await replaceNodes(wsId, nodes);
      setUploadedCount(nodes.filter((n) => n.type === "file").length);
    } catch (e) {
      if ((e as Error).name !== "AbortError") window.alert("Could not open folder.");
    } finally {
      setScanning(false);
    }
  };

  /* ── After upload: extract IDB files to a real local folder on disk ─── */
  const handleSaveToDisk = async () => {
    try {
      const handle = await pickDirectory();
      setExtracting(true);

      const nodes = await getAllNodes(wsId);
      let written = 0;
      for (const node of nodes) {
        if (node.type !== "file") continue;
        const file = await getFile(wsId, node.path);
        if (!file || file.content === "(binary)") continue;
        await writeFsFile(handle, node.path, file.content).catch(() => {});
        written++;
      }

      await storeDirectoryHandle(wsId, handle);
      cacheHandle(wsId, handle);
      setPickedHandle(handle);
      // Always overwrite with the destination folder name — user completes the full path
      setLocalPathLabel(handle.name);
      setUploadedCount(written);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        window.alert(`Could not save to folder: ${(e as Error).message}`);
      }
    } finally {
      setExtracting(false);
    }
  };

  /* ── Daemon: open the native OS folder dialog and fill the path field ──── */
  const handleAgentBrowse = async () => {
    try {
      setBrowsing(true);
      const picked = await agentClient.pickFolder();
      if (picked) { setAgentPath(picked); setPathError(""); }
    } finally {
      setBrowsing(false);
    }
  };

  /* ── Daemon: bind an absolute path the local daemon can see ────────────── */
  const bindAgentRoot = async (create = false): Promise<FileAccess | null> => {
    const p = stripQuotes(agentPath.trim()).trim();
    if (!p || !isValidFullPath(p)) {
      setPathError(FULL_PATH_REQUIRED_MSG);
      return null;
    }
    setPathError("");
    const fa = await openAgentRoot(p, create); // create=true when saving uploads
    setAgentAccess(fa);
    setPickedHandle(null);
    setLocalPathLabel(p);
    if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() || "");
    return fa;
  };

  /* Daemon: link an existing folder by path (scan only). */
  const handleAgentLink = async () => {
    try {
      setScanning(true);
      const fa = await bindAgentRoot(false);
      if (!fa) return;
      const nodes = await fa.scan();
      await replaceNodes(wsId, nodes);
      setUploadedCount(nodes.filter((n) => n.type === "file").length);
    } catch (e) {
      window.alert(`Could not open folder via daemon: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  /* Daemon: write uploaded IDB files to the path on disk. */
  const handleAgentSaveToDisk = async () => {
    try {
      setExtracting(true);
      const fa = await bindAgentRoot(true); // mkdir-p the target if new
      if (!fa) return;
      const nodes = await getAllNodes(wsId);
      let written = 0;
      let firstError: string | null = null;
      for (const node of nodes) {
        if (node.type !== "file") continue;
        const file = await getFile(wsId, node.path);
        if (!file || file.content === "(binary)") continue;
        try { await fa.write(node.path, file.content); written++; }
        catch (err) { if (!firstError) firstError = (err as Error).message; }
      }
      setUploadedCount(written);
      if (firstError) window.alert(`Some files could not be written to disk: ${firstError}`);
      else if (written === 0) window.alert("No files were written — the upload may not contain readable text files.");
    } catch (e) {
      window.alert(`Could not save to folder via daemon: ${(e as Error).message}`);
    } finally {
      setExtracting(false);
    }
  };

  /* ── Git: auto-detect provider + repo name from URL ─────────────────── */
  const handleRepoUrlChange = (url: string) => {
    setRepoUrl(url);
    setCloneError("");
    const detected = detectProvider(url);
    if (detected) setGitProvider(detected);
    const repoName = extractRepoName(url);
    if (repoName && repoName !== "workspace" && !name) setName(repoName);
  };

  /* ── Git: fetch branches ───────────────────────────────────────────── */
  const handleFetchBranches = async () => {
    if (!repoUrl.trim()) return;
    setLoadingBranches(true);
    try {
      const list = await listBranches(repoUrl, gitProvider, patToken || undefined);
      setBranches(list);
      if (list.length > 0 && !list.includes(branch)) setBranch(list[0]);
    } catch {
      setBranches(["main"]);
    } finally {
      setLoadingBranches(false);
    }
  };

  /* ── Git: clone repo into workspace ────────────────────────────────── */
  const handleClone = async () => {
    if (!repoUrl.trim()) { setCloneError("Repository URL is required."); return; }
    if (!pickedHandle) { setCloneError("Open or save to a local folder before cloning."); return; }
    setCloning(true);
    setCloneError("");
    try {
      const response = await cloneRepo({
        repoUrl: repoUrl.trim(),
        branch,
        provider: gitProvider,
        patToken: patToken || undefined,
      });
      const output: SpecSubtaskOutput = {
        project_name: response.project_name,
        summary: `Cloned from ${gitProvider}`,
        folders: response.folders,
        files: response.files.map((f) => ({
          path: f.path, content: f.content, language: f.language,
          purpose: "", bytes: f.size, valid: true, error: null,
        })),
      };
      const result = await writeSpecFilesToWorkspace(wsId, output);
      setUploadedCount(result.fileCount);
      if (!name) setName(response.project_name);
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  };

  /* The concrete, transport-agnostic access chosen by the user (daemon or FS). */
  const boundAccess: FileAccess | null =
    agentAccess ?? (pickedHandle ? fromHandle(pickedHandle) : null);

  /* ── Create workspace record and open IDE ────────────────────────────── */
  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setNameError("Workspace name is required."); return; }
    if (!boundAccess) {
      window.alert("Please link a local folder (via the daemon or a browser folder) before creating a workspace.");
      return;
    }
    // Full Path is mandatory: creation cannot proceed without a valid absolute path.
    // Strip any wrapping quotes first (Windows "Copy as path" adds them).
    const pathLabel = stripQuotes(localPathLabel.trim()).trim();
    if (!pathLabel || !isValidFullPath(pathLabel)) {
      setPathError(FULL_PATH_REQUIRED_MSG);
      setTimeout(() => pathInputRef.current?.focus(), 0);
      return;
    }
    setNameError("");
    setPathError("");
    setSaving(true);
    try {
      const created = await createWorkspace(
        trimmed,
        description.trim() || undefined,
        pathLabel,
      );
      const nodes = await boundAccess.scan();
      await replaceNodes(created.id, nodes);
      await createLocalWorkspace(
        {
          name: trimmed,
          description: description.trim() || undefined,
          localPathLabel: pathLabel,
          fileCount: nodes.filter((n) => n.type === "file").length,
        },
        created.id,
      );
      // Bind this workspace to its transport (daemon OR FS handle) so the IDE
      // resolves the correct one — this is what makes agent writes land here.
      setWorkspaceFileAccess(created.id, boundAccess);
      if (pickedHandle) {
        await storeDirectoryHandle(created.id, pickedHandle);
        cacheHandle(created.id, pickedHandle);
      }
      onClose();
      router.push(`/workspaces/${created.id}/ide`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409 || /already exists/i.test(e.message ?? "")) {
        // Duplicate name — keep the modal open and let the user rename.
        setNameError(`A workspace named "${trimmed}" already exists. Please choose a different name.`);
      } else {
        window.alert(e.message || "Failed to create workspace. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const inputCls =
    "w-full h-9 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] px-3 text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500";
  const labelCls = "block text-xs font-medium text-[var(--ide-text)] mb-1.5";
  const hasRoot = !!boundAccess;
  const rootLabel = agentAccess ? agentAccess.rootLabel : pickedHandle?.name ?? "";
  const uploadedViaBrowser = uploadedCount !== null && !hasRoot;
  // Precedence: prefer the daemon whenever connected (works over HTTP); fall back
  // to the browser FS API only when there's no daemon (HTTPS/localhost).
  const useFsApi = cap.fsApi && !cap.agent;
  const agentPathCls =
    "w-full h-8 rounded border bg-[var(--ide-surface)] px-2 text-[12px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 font-mono border-[var(--ide-border)] focus:ring-violet-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-xl mx-4 rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--ide-border)] shrink-0">
          <FolderGit2 className="h-4.5 w-4.5 text-violet-400" />
          <h2 className="text-sm font-semibold text-[var(--ide-text)] flex-1">New Workspace</h2>
          <button type="button" onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          <form id="new-ws-form" onSubmit={handleSubmit} className="p-5 space-y-5">

            {/* ── Source tabs ──────────────────────────────────────── */}
            <div className="rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface-2)]/50 overflow-hidden">
              <p className="px-4 pt-3 text-[11px] text-[var(--ide-muted)]">
                Import source <span className="text-[var(--ide-muted)]">— optional, skip to create an empty workspace</span>
              </p>
              {/* Tab bar */}
              <div className="flex border-b border-[var(--ide-border)] mt-2">
                {([
                  { id: "local"  as SourceTab, label: "Local Folder", Icon: FolderOpen },
                  { id: "upload" as SourceTab, label: "Upload",       Icon: Upload },
                  { id: "git"    as SourceTab, label: "Git Clone",    Icon: GitBranch },
                ]).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSourceTab(id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 h-9 text-xs font-medium transition-colors ${
                      sourceTab === id
                        ? "bg-violet-600/10 text-violet-300 border-b-2 border-violet-500"
                        : "text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)]"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              <div className="p-4 space-y-3">

              {/* ── LOCAL TAB ──────────────────────────────────────── */}
              {sourceTab === "local" && (
              <>
              {hasRoot ? (
                /* Linked folder state */
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2.5 p-2.5 rounded-md bg-emerald-950/30 border border-emerald-800/40">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-emerald-300 truncate">{rootLabel}</p>
                      {(scanning || extracting) ? (
                        <p className="text-[11px] text-[var(--ide-muted)] flex items-center gap-1 mt-0.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {extracting ? "Writing files to disk…" : "Scanning files…"}
                        </p>
                      ) : uploadedCount !== null ? (
                        <p className="text-[11px] text-[var(--ide-muted)] mt-0.5">
                          {uploadedCount} file{uploadedCount !== 1 ? "s" : ""} ready{agentAccess ? " · via local daemon" : ""}
                        </p>
                      ) : null}
                    </div>
                    {!scanning && !extracting && fsAvailable && !!pickedHandle && (
                      <button type="button" onClick={handlePickFolder}
                        className="text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] underline shrink-0">
                        Change
                      </button>
                    )}
                  </div>

                  {/* Full local path — shown in IDE TopBar */}
                  <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)]/60 px-3 py-2.5">
                    <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] mb-1.5">
                      <MapPin className="h-3 w-3" />
                      FULL PATH — shown in IDE header
                    </label>
                    <input
                      ref={pathInputRef}
                      value={localPathLabel}
                      onChange={(e) => { setLocalPathLabel(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
                      onFocus={(e) => e.target.select()}
                      placeholder={`e.g. C:\\Users\\you\\Downloads\\${rootLabel}`}
                      aria-invalid={!!pathError}
                      className={`w-full h-8 rounded border bg-[var(--ide-surface)] px-2 text-[12px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 font-mono ${
                        pathError ? "border-red-500 focus:ring-red-500" : "border-[var(--ide-border)] focus:ring-violet-500"
                      }`}
                    />
                    {pathError && <p className="mt-1 text-[10px] text-red-400 leading-relaxed">{pathError}</p>}
                    {agentAccess ? (
                      <p className="mt-1.5 text-[10px] text-[var(--ide-muted)] leading-relaxed">
                        Files are written by the local daemon to <span className="font-mono text-[var(--ide-text)]">{rootLabel}</span> on your machine.
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[10px] text-[var(--ide-muted)] leading-relaxed">
                        The browser only sees the folder name, not the full path. To paste it:
                        in File Explorer, <strong className="text-[var(--ide-text)]">hold Shift, right-click the folder → &ldquo;Copy as path&rdquo;</strong>,
                        then click the field above and press <kbd className="px-1 rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] font-mono">Ctrl+V</kbd>.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                /* No folder linked — daemon (HTTP) preferred, FS API fallback */
                <>
                  {cap.agent && (
                    <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)]/60 px-3 py-2.5 space-y-2">
                      <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-[var(--ide-muted)]">
                        <Server className="h-3 w-3" /> LOCAL FOLDER PATH (via daemon)
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={agentPath}
                          onChange={(e) => { setAgentPath(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
                          placeholder="e.g. C:\\Users\\me\\projects\\my-app"
                          aria-invalid={!!pathError}
                          className={`flex-1 ${agentPathCls}`}
                        />
                        <button type="button" onClick={handleAgentBrowse} disabled={browsing}
                          title="Open a folder picker on your machine"
                          className="inline-flex items-center gap-1 h-8 px-2.5 rounded border border-[var(--ide-border)] hover:border-violet-500 disabled:opacity-50 text-[11px] text-[var(--ide-text)] hover:text-violet-300 transition-colors shrink-0 whitespace-nowrap">
                          {browsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                          {browsing ? "Waiting…" : "Browse…"}
                        </button>
                      </div>
                      {pathError && <p className="text-[10px] text-red-400">{pathError}</p>}
                      {browsing && <p className="text-[10px] text-amber-400/90">A folder dialog opened on your machine — pick a folder (it may be behind this window).</p>}
                      <button type="button" onClick={handleAgentLink} disabled={scanning}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors">
                        {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                        {scanning ? "Opening…" : "Open folder via daemon"}
                      </button>
                    </div>
                  )}
                  {useFsApi && (
                    <button type="button" onClick={handlePickFolder}
                      className="w-full flex items-center justify-center gap-2 h-10 rounded-md border border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-sm text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
                      <FolderOpen className="h-4 w-4" />
                      Open Local Folder
                    </button>
                  )}
                  {!cap.agent && !useFsApi && (
                    <div className="flex items-start gap-2.5 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
                      <Server className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-[var(--ide-muted)] leading-relaxed">
                        Local file access isn&apos;t connected. Open the <span className="text-[var(--ide-text)] font-medium">Daemon Setup</span> menu to install &amp; connect the daemon, then reopen this dialog.
                      </p>
                    </div>
                  )}
                </>
              )}

              </>
              )}

              {/* ── UPLOAD TAB ─────────────────────────────────────── */}
              {sourceTab === "upload" && (
              <>
                <WorkspaceUploadZone
                  workspaceId={wsId}
                  onDone={({ fileCount, sourceName }) => {
                    setUploadedCount(fileCount);
                    if (!name && sourceName)  setName(sourceName);
                    if (!name && !sourceName) setName(`Workspace ${new Date().toLocaleDateString()}`);
                  }}
                />

                {/* Daemon save-to-disk (works over plain HTTP — the VM case) */}
                {uploadedViaBrowser && cap.agent && (
                  <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
                    <HardDriveDownload className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-amber-300">Save uploaded files to your disk (via local daemon)</p>
                      <p className="text-[11px] text-[var(--ide-muted)] mt-0.5 leading-relaxed">
                        Choose the local folder where the daemon should write these files.
                      </p>
                      <div className="mt-2 flex items-center gap-1.5">
                        <input
                          value={agentPath}
                          onChange={(e) => { setAgentPath(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
                          placeholder="e.g. C:\\Users\\me\\projects\\my-app"
                          aria-invalid={!!pathError}
                          className={`flex-1 ${agentPathCls}`}
                        />
                        <button type="button" onClick={handleAgentBrowse} disabled={browsing}
                          title="Open a folder picker on your machine"
                          className="inline-flex items-center gap-1 h-8 px-2.5 rounded border border-[var(--ide-border)] hover:border-violet-500 disabled:opacity-50 text-[11px] text-[var(--ide-text)] hover:text-violet-300 transition-colors shrink-0">
                          {browsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                          Browse…
                        </button>
                      </div>
                      {pathError && <p className="mt-1 text-[10px] text-red-400">{pathError}</p>}
                      {browsing && <p className="mt-1 text-[10px] text-amber-400/90">A folder dialog opened on your machine — pick a folder (it may be behind this window).</p>}
                      <button type="button" onClick={handleAgentSaveToDisk} disabled={extracting}
                        className="mt-2 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors">
                        {extracting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
                        {extracting ? "Saving to disk…" : "Save to disk via daemon"}
                      </button>
                    </div>
                  </div>
                )}

                {/* FS-API save-to-disk (HTTPS/localhost only) */}
                {uploadedViaBrowser && useFsApi && (
                  <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
                    <HardDriveDownload className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-amber-300">Files are in browser storage only</p>
                      <p className="text-[11px] text-[var(--ide-muted)] mt-0.5 leading-relaxed">
                        Pick a local folder to extract the files to disk.
                      </p>
                      <button
                        type="button"
                        onClick={handleSaveToDisk}
                        disabled={extracting}
                        className="mt-2 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors"
                      >
                        {extracting
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <FolderOpen className="h-3 w-3" />}
                        {extracting ? "Saving to disk…" : "Pick folder & save to disk"}
                      </button>
                    </div>
                  </div>
                )}

                {/* No transport — point to Setup Daemon */}
                {uploadedViaBrowser && !cap.agent && !useFsApi && (
                  <div className="flex items-start gap-2.5 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
                    <Server className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-[var(--ide-muted)] leading-relaxed">
                      Files are in browser storage. To save them to your disk, open the{" "}
                      <span className="text-[var(--ide-text)] font-medium">Daemon Setup</span> menu and connect the daemon.
                    </p>
                  </div>
                )}
              </>
              )}

              {/* ── GIT TAB ────────────────────────────────────────── */}
              {sourceTab === "git" && (
              <div className="space-y-3">
                {/* Repo URL */}
                <div>
                  <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Repository URL</label>
                  <input
                    value={repoUrl}
                    onChange={(e) => handleRepoUrlChange(e.target.value)}
                    placeholder={PROVIDER_INFO[gitProvider].placeholder}
                    className={inputCls}
                  />
                </div>

                {/* Provider chips */}
                <div>
                  <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1.5">Provider</label>
                  <div className="flex gap-1.5">
                    {(Object.keys(PROVIDER_INFO) as GitProvider[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setGitProvider(p)}
                        className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
                          gitProvider === p
                            ? "bg-violet-600/20 text-violet-300 border border-violet-500/40"
                            : "bg-[var(--ide-surface-2)] text-[var(--ide-muted)] border border-[var(--ide-border)] hover:border-slate-500"
                        }`}
                      >
                        <Globe className="h-3 w-3" />
                        {PROVIDER_INFO[p].label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Branch selector */}
                <div>
                  <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">Branch</label>
                  <div className="flex gap-2">
                    {branches.length > 0 ? (
                      <select
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        className="flex-1 h-9 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] px-2 text-sm text-[var(--ide-text)] focus:outline-none focus:ring-1 focus:ring-violet-500"
                      >
                        {branches.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder="main"
                        className={`flex-1 ${inputCls}`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={handleFetchBranches}
                      disabled={!repoUrl.trim() || loadingBranches}
                      className="h-9 px-3 rounded-md border border-[var(--ide-border)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)] disabled:opacity-40 transition-colors"
                    >
                      {loadingBranches ? <Loader2 className="h-3 w-3 animate-spin" /> : "Fetch"}
                    </button>
                  </div>
                </div>

                {/* Access token (optional) */}
                <div>
                  <label className="block text-[11px] font-medium text-[var(--ide-muted)] mb-1">
                    Access Token <span className="text-[var(--ide-muted)] font-normal">(optional — for private repos)</span>
                  </label>
                  <div className="relative">
                    <Key className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ide-muted)]" />
                    <input
                      type="password"
                      value={patToken}
                      onChange={(e) => setPatToken(e.target.value)}
                      placeholder="ghp_xxxx or glpat-xxxx"
                      className={`${inputCls} pl-8`}
                    />
                  </div>
                </div>

                {/* Clone button */}
                <button
                  type="button"
                  onClick={handleClone}
                  disabled={!repoUrl.trim() || cloning}
                  className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-md bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-50 text-sm font-medium text-white transition-all"
                >
                  {cloning ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Cloning…</>
                  ) : (
                    <><GitBranch className="h-4 w-4" /> Clone &amp; Import</>
                  )}
                </button>

                {/* Clone result */}
                {cloneError && (
                  <p className="text-xs text-red-400">{cloneError}</p>
                )}
                {uploadedCount !== null && sourceTab === "git" && !cloning && (
                  <div className="flex items-center gap-2 p-2.5 rounded-md bg-emerald-950/30 border border-emerald-800/40">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <p className="text-xs text-emerald-300">{uploadedCount} files cloned successfully</p>
                  </div>
                )}
              </div>
              )}

              </div>
            </div>

            {/* ── Name ────────────────────────────────────────────────── */}
            <div>
              <label className={labelCls}>
                Workspace Name <span className="text-red-400">*</span>
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => { setName(e.target.value); if (nameError) setNameError(""); }}
                placeholder="e.g. Auth Microservice"
                className={`${inputCls} ${nameError ? "border-red-500 focus:ring-red-500" : ""}`}
              />
              {nameError && <p className="mt-1 text-xs text-red-400">{nameError}</p>}
            </div>

            {/* ── Description ─────────────────────────────────────────── */}
            <div>
              <label className={labelCls}>
                Description <span className="text-[var(--ide-muted)] font-normal">(optional)</span>
              </label>
              <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this workspace…"
                className="w-full rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] px-3 py-2 text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
              />
            </div>

            {/* Path label — hidden only when local tab has a linked folder (it has its own) */}
            {(!pickedHandle || sourceTab !== "local") && (
              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--ide-text)] mb-1.5">
                  <MapPin className="h-3.5 w-3.5 text-[var(--ide-muted)]" />
                  Full Path <span className="text-[var(--ide-muted)] font-normal">(shown in IDE header — optional)</span>
                </label>
                <input
                  value={localPathLabel}
                  onChange={(e) => { setLocalPathLabel(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
                  onFocus={(e) => e.target.select()}
                  placeholder="e.g. C:\Users\me\projects\auth-service"
                  aria-invalid={!!pathError}
                  className={`${inputCls} font-mono text-[12px] ${pathError ? "border-red-500 focus:ring-red-500" : ""}`}
                />
                {pathError && <p className="mt-1 text-xs text-red-400">{pathError}</p>}
                <p className="mt-1.5 text-[10px] text-[var(--ide-muted)] leading-relaxed">
                  In File Explorer, <strong className="text-[var(--ide-text)]">hold Shift, right-click the folder → &ldquo;Copy as path&rdquo;</strong>,
                  then click the field above and press <kbd className="px-1 rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] font-mono">Ctrl+V</kbd>.
                </p>
              </div>
            )}
          </form>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-[var(--ide-border)] shrink-0">
          <button type="button" onClick={onClose}
            className="h-9 px-4 rounded-md border border-[var(--ide-border)] text-sm text-[var(--ide-text)] hover:bg-[var(--ide-surface-2)] transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            form="new-ws-form"
            disabled={saving || scanning || extracting || !boundAccess || !name.trim()}
            className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderGit2 className="h-4 w-4" />}
            Create &amp; Open
          </button>
        </div>
      </div>
    </div>
  );
}

export default NewWorkspaceModal;
