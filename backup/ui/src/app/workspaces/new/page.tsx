"use client";

import React, { useRef, useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, FolderGit2, Loader2, FolderOpen,
  CheckCircle2, HardDriveDownload, MapPin, ShieldAlert, Server,
} from "lucide-react";
import {
  createLocalWorkspace,
  replaceNodes,
  getAllNodes,
  getFile,
} from "@/lib/db/workspaceStore";
import { createWorkspace } from "@/lib/workspace-api";
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";
import { WorkspaceUploadZone } from "@/components/ide/WorkspaceUploadZone";
import {
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

/** Message shown inline when the Full Path is missing or not a real absolute path. */
const FULL_PATH_REQUIRED_MSG =
  "Full Path is required to create a workspace. Please provide a valid Full Path and try again.";

/** Strip wrapping quotes (Windows "Copy as path" yields `"C:\...\folder"`). */
const stripQuotes = (p: string): string => p.replace(/^["']+|["']+$/g, "");

/** A real absolute path: Windows drive (C:\ or C:/), POSIX root (/…), or UNC (\\…). */
const isValidFullPath = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || /^\\\\/.test(p);

export default function NewWorkspacePage() {
  const router = useRouter();
  const wsIdRef     = useRef<number>(Date.now());
  const pathInputRef = useRef<HTMLInputElement>(null);
  const wsId = wsIdRef.current;

  const [name,           setName]           = useState("");
  const [description,    setDescription]    = useState("");
  const [localPathLabel, setLocalPathLabel] = useState("");
  const [uploadedCount,  setUploadedCount]  = useState<number | null>(null);
  const [saving,         setSaving]         = useState(false);
  const [nameError,      setNameError]      = useState("");
  const [pathError,      setPathError]      = useState("");
  const [pickedHandle,   setPickedHandle]   = useState<FileSystemDirectoryHandle | null>(null);
  const [agentAccess,    setAgentAccess]    = useState<FileAccess | null>(null);
  const [agentPath,      setAgentPath]      = useState("");
  const [scanning,       setScanning]       = useState(false);
  const [extracting,     setExtracting]     = useState(false);
  // Local-file capability: daemon on 127.0.0.1 (works over HTTP) and/or the
  // browser File System Access API (needs HTTPS/localhost).
  const [cap,            setCap]            = useState<{ agent: boolean; fsApi: boolean }>({ agent: false, fsApi: false });

  useEffect(() => {
    if (!canAccessWorkspaceStudio()) { router.replace("/"); return; }
    let cancelled = false;

    // NO interval polling — it would fill the network tab with failing health
    // probes for as long as no daemon exists. Instead, detection is event-driven:
    // one check on load, then a re-check each time the user RETURNS to this tab
    // (window focus / tab visible) — which is exactly what happens right after
    // they run the installer. recheckDaemon() is also wired to a "Check now"
    // link in the notice.
    const detach: Array<() => void> = [];

    const applyFound = () => setCap((prev) => ({ ...prev, agent: true }));

    // Focus events fire on EVERY click between DevTools and the page, so
    // rechecks are (a) throttled to one per 5s, (b) a single-port probe
    // (1 request — not an 8-port scan), and (c) never overlapping. Only the
    // explicit "Check now" click does a full forced scan.
    let lastCheckAt = 0;
    let checking = false;
    const recheck = async (force = false) => {
      if (cancelled || checking) return;
      if (!force && Date.now() - lastCheckAt < 5000) return;
      checking = true;
      lastCheckAt = Date.now();
      try {
        const found = force
          ? (await agentClient.discover(true).catch(() => null)) !== null
          : await agentClient.quickDetect().catch(() => false);
        if (cancelled || !found) return;
        applyFound();
        detach.forEach((fn) => fn()); // connected — stop listening
        detach.length = 0;
      } finally {
        checking = false;
      }
    };

    (async () => {
      const c = await getCapability().catch(() => ({ agent: false, fsApi: false }));
      if (cancelled) return;
      setCap({ agent: c.agent, fsApi: c.fsApi });
      if (c.agent || c.fsApi) return; // nothing to wait for

      const onFocus = () => { void recheck(); };
      const onVisible = () => { if (!document.hidden) void recheck(); };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisible);
      detach.push(() => window.removeEventListener("focus", onFocus));
      detach.push(() => document.removeEventListener("visibilitychange", onVisible));
    })();

    return () => { cancelled = true; detach.forEach((fn) => fn()); };
  }, [router]);

  /* The concrete, transport-agnostic access chosen by the user (agent or FS API). */
  const boundAccess: FileAccess | null = useMemo(
    () => agentAccess ?? (pickedHandle ? fromHandle(pickedHandle) : null),
    [agentAccess, pickedHandle],
  );
  const hasRoot = !!boundAccess;
  const rootLabel = agentAccess ? agentAccess.rootLabel : pickedHandle?.name ?? "";

  /* Focus path input when a folder is first linked */
  useEffect(() => {
    if (hasRoot) setTimeout(() => pathInputRef.current?.focus(), 50);
  }, [hasRoot]);

  /* ── FS API: link an existing local folder (HTTPS/localhost) ──────────── */
  const handlePickFolder = async () => {
    try {
      const handle = await pickDirectory();
      setPickedHandle(handle);
      setAgentAccess(null);
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

  /* ── FS API: extract uploaded IDB files to a picked folder on disk ─────── */
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
      setAgentAccess(null);
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
  const [browsing, setBrowsing] = useState(false);
  const handleAgentBrowse = async () => {
    try {
      setBrowsing(true);
      const picked = await agentClient.pickFolder();
      if (picked) { setAgentPath(picked); setPathError(""); }
    } finally {
      setBrowsing(false);
    }
  };

  /* ── Daemon: bind an absolute path the local agent can see ─────────────── */
  const bindAgentRoot = async (create = false): Promise<FileAccess | null> => {
    const p = stripQuotes(agentPath.trim()).trim();
    if (!p || !isValidFullPath(p)) {
      setPathError(FULL_PATH_REQUIRED_MSG);
      return null;
    }
    setPathError("");
    // create=true when saving uploaded files (folder may not exist yet).
    const fa = await openAgentRoot(p, create);
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
      const fa = await bindAgentRoot();
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
      // create=true — the daemon mkdir-p's the target folder if it's new.
      const fa = await bindAgentRoot(true);
      if (!fa) return;
      const nodes = await getAllNodes(wsId);
      let written = 0;
      let firstError: string | null = null;
      for (const node of nodes) {
        if (node.type !== "file") continue;
        const file = await getFile(wsId, node.path);
        if (!file || file.content === "(binary)") continue;
        try {
          await fa.write(node.path, file.content);
          written++;
        } catch (err) {
          if (!firstError) firstError = (err as Error).message;
        }
      }
      setUploadedCount(written);
      // Surface failures instead of silently reporting success.
      if (firstError) {
        window.alert(`Some files could not be written to disk: ${firstError}`);
      } else if (written === 0) {
        window.alert("No files were written — the upload may not contain readable text files.");
      }
    } catch (e) {
      window.alert(`Could not save to folder via daemon: ${(e as Error).message}`);
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setNameError("Workspace name is required."); return; }
    if (!boundAccess) {
      window.alert("Please link a local folder before creating a workspace.");
      return;
    }
    // Full Path is mandatory: creation cannot proceed without a valid absolute path.
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
      // Bind this workspace to its transport so the IDE resolves the right one.
      setWorkspaceFileAccess(created.id, boundAccess);
      if (pickedHandle) {
        await storeDirectoryHandle(created.id, pickedHandle);
        cacheHandle(created.id, pickedHandle);
      }
      router.push(`/workspaces/${created.id}/ide`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409 || /already exists/i.test(e.message ?? "")) {
        setNameError(`A workspace named "${trimmed}" already exists. Please choose a different name.`);
      } else {
        window.alert(e.message || "Failed to create workspace. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full h-9 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
  const labelCls = "block text-xs font-medium text-slate-300 mb-1.5";
  const agentPathCls =
    "w-full h-8 rounded border bg-slate-900 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 font-mono border-slate-600 focus:ring-violet-500";
  const uploadedViaBrowser = uploadedCount !== null && !hasRoot;
  const anyLocalAccess = cap.fsApi || cap.agent;
  // Precedence: prefer the local daemon whenever it's connected (works over HTTP,
  // native folder dialog, and shared with CLI/IDE); fall back to the browser File
  // System Access API only when no daemon is present. So the FS-API UI shows only
  // when there's no daemon.
  const useFsApi = cap.fsApi && !cap.agent;

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <button type="button" onClick={() => router.push("/workspaces")}
          className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <FolderGit2 className="h-5 w-5 text-violet-400" />
        <h1 className="text-lg font-semibold text-slate-100">New Workspace</h1>
        {/* {cap.agent && (
          <span className="ml-auto inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-emerald-950/40 border border-emerald-800/50 text-[11px] text-emerald-300">
            <Server className="h-3 w-3" /> Local daemon connected
          </span>
        )} */}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* ── Source ──────────────────────────────────────────────────── */}
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-300">
            Source <span className="text-slate-500 font-normal">— link a folder or upload files</span>
          </p>

          {hasRoot ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2.5 p-2.5 rounded-md bg-emerald-950/30 border border-emerald-800/40">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-emerald-300 truncate">{rootLabel}</p>
                  {(scanning || extracting) ? (
                    <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {extracting ? "Writing files to disk…" : "Scanning files…"}
                    </p>
                  ) : uploadedCount !== null ? (
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {uploadedCount} file{uploadedCount !== 1 ? "s" : ""} ready
                      {agentAccess ? " · via local daemon" : ""}
                    </p>
                  ) : null}
                </div>
                {!scanning && !extracting && cap.fsApi && !!pickedHandle && (
                  <button type="button" onClick={handlePickFolder}
                    className="text-[11px] text-slate-400 hover:text-slate-200 underline shrink-0">
                    Change
                  </button>
                )}
              </div>

              {/* Full local path input — goes into TopBar */}
              <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-400 mb-1.5">
                  <MapPin className="h-3 w-3" />
                  FULL PATH — shown in workspace header
                </label>
                <input
                  ref={pathInputRef}
                  value={localPathLabel}
                  onChange={(e) => { setLocalPathLabel(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
                  placeholder={`e.g. C:\\Users\\you\\Downloads\\${rootLabel}`}
                  aria-invalid={!!pathError}
                  className={`w-full h-8 rounded border bg-slate-900 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 font-mono ${
                    pathError ? "border-red-500 focus:ring-red-500" : "border-slate-600 focus:ring-violet-500"
                  }`}
                />
                {pathError && <p className="mt-1 text-[10px] text-red-400">{pathError}</p>}
                {agentAccess ? (
                  <p className="mt-1.5 text-[10px] text-slate-500 leading-relaxed">
                    Files are written by the local daemon to <span className="font-mono text-slate-400">{rootLabel}</span> on your machine.
                  </p>
                ) : (
                  <p className="mt-1.5 text-[10px] text-slate-500 leading-relaxed">
                    Browser security can only read the folder name (<span className="font-mono text-slate-400">{rootLabel}</span>).
                    Type your full local path above — it will appear in the workspace header.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* FS API path (HTTPS/localhost) — link an existing folder.
                  Hidden once files are uploaded to avoid competing with the
                  "save uploaded files to disk" action below. */}
              {useFsApi && uploadedCount === null && (
                <button type="button" onClick={handlePickFolder}
                  className="w-full flex items-center justify-center gap-2 h-10 rounded-md border border-dashed border-slate-600 hover:border-violet-500 hover:bg-violet-600/5 text-sm text-slate-400 hover:text-violet-300 transition-colors">
                  <FolderOpen className="h-4 w-4" />
                  Open Local Folder
                </button>
              )}

              {/* Daemon path — preferred whenever the daemon is connected
                  (works over plain HTTP AND in Chrome on HTTPS/localhost). */}
              {cap.agent && uploadedCount === null && (
                <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2.5 space-y-2">
                  <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-400">
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
                      className="inline-flex items-center gap-1 h-8 px-2.5 rounded border border-slate-600 hover:border-violet-500 disabled:opacity-50 text-[11px] text-slate-300 hover:text-violet-300 transition-colors shrink-0 whitespace-nowrap">
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
            </>
          )}

          {!hasRoot && (
            <>
              <p className="text-[11px] text-slate-500">Or upload a ZIP / folder:</p>
              <WorkspaceUploadZone
                workspaceId={wsId}
                onDone={({ fileCount, sourceName }) => {
                  setUploadedCount(fileCount);
                  if (!name && sourceName)  setName(sourceName);
                  if (!name && !sourceName) setName(`Workspace ${new Date().toLocaleDateString()}`);
                }}
              />
            </>
          )}

          {/* FS API save-to-disk (HTTPS/localhost) */}
          {uploadedViaBrowser && useFsApi && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
              <HardDriveDownload className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-amber-300">Files are in browser storage only</p>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Pick a local folder to extract files to disk. You&apos;ll then confirm the full path for the workspace header.
                </p>
                <button type="button" onClick={handleSaveToDisk} disabled={extracting}
                  className="mt-2 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors">
                  {extracting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                  {extracting ? "Saving to disk…" : "Pick folder & save to disk"}
                </button>
              </div>
            </div>
          )}

          {/* Daemon save-to-disk (works over plain HTTP) */}
          {uploadedViaBrowser && cap.agent && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
              <HardDriveDownload className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-amber-300">Save uploaded files to your disk (via local daemon)</p>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
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
                    className="inline-flex items-center gap-1 h-8 px-2.5 rounded border border-slate-600 hover:border-violet-500 disabled:opacity-50 text-[11px] text-slate-300 hover:text-violet-300 transition-colors shrink-0">
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

          {/* Neither transport available — daemon management now lives on the
              Daemon Setup page (this page is only reachable once connected). */}
          {uploadedViaBrowser && !anyLocalAccess && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/20 border border-amber-800/40">
              <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-amber-300">Saving to disk isn&apos;t available here</p>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Local file access isn&apos;t connected. Open the{" "}
                  <span className="text-slate-300 font-medium">Daemon Setup</span> menu to install &amp;
                  connect the daemon, then return here.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Name ──────────────────────────────────────────────────────── */}
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

        {/* ── Description ───────────────────────────────────────────────── */}
        <div>
          <label className={labelCls}>
            Description <span className="text-slate-500">(optional)</span>
          </label>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this workspace…"
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
          />
        </div>

        {/* Standalone path label — only when no folder linked */}
        {!hasRoot && (
          <div>
            <label className={labelCls}>
              Path Label <span className="text-slate-500">(shown in workspace header — optional)</span>
            </label>
            <input
              value={localPathLabel}
              onChange={(e) => { setLocalPathLabel(stripQuotes(e.target.value)); if (pathError) setPathError(""); }}
              placeholder="e.g. C:\Users\me\projects\auth-service"
              aria-invalid={!!pathError}
              className={`${inputCls} ${pathError ? "border-red-500 focus:ring-red-500" : ""}`}
            />
            {pathError && <p className="mt-1 text-xs text-red-400">{pathError}</p>}
            <p className="mt-1.5 text-xs text-slate-500">
              Files live in browser storage unless you link a local folder above.
            </p>
          </div>
        )}

        {/* ── Actions ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-800">
          <button type="button" onClick={() => router.push("/workspaces")}
            className="h-9 px-4 rounded-md border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={saving || scanning || extracting || !boundAccess || !name.trim()}
            className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderGit2 className="h-4 w-4" />}
            Create &amp; Open Workspace
          </button>
        </div>
      </form>
    </div>
  );
}
