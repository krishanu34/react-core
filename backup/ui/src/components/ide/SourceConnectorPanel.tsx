"use client";

/**
 * SourceConnectorPanel — import files into the current workspace from
 * a local folder, ZIP/folder upload, or Git repository.
 *
 * Shown in the sidebar when the "Source Connector" activity bar icon is selected.
 * Reuses WorkspaceUploadZone for upload and git-clone-api for Git.
 */
import { useState, useRef, useEffect } from "react";
import {
  FolderOpen, Upload, GitBranch, Loader2, CheckCircle2,
  Globe, Key, Server,
} from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import { useGlobalProject } from "@/providers/ProjectProvider";
import { WorkspaceUploadZone } from "@/components/ide/WorkspaceUploadZone";
import {
  isFsApiAvailable,
  pickDirectory,
  storeDirectoryHandle,
  cacheHandle,
  getCachedHandle,
  scanDirectory,
  writeFsFile,
} from "@/lib/localFs";
import {
  getCapability,
  openAgentRoot,
  setWorkspaceFileAccess,
  agentClient,
} from "@/lib/fileAccess";
import { replaceNodes, getAllNodes, getFile } from "@/lib/db/workspaceStore";
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

type Tab = "local" | "upload" | "git";

const stripQuotes = (p: string): string => p.replace(/^["']+|["']+$/g, "");
const isValidFullPath = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || /^\\\\/.test(p);

export function SourceConnectorPanel({
  workspaceId,
}: {
  workspaceId: number;
}) {
  const { bumpTreeRevision } = useWorkspace();
  const { selectedProjectId, selectedProject } = useGlobalProject();

  const [tab, setTab] = useState<Tab>("local");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError]   = useState("");
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasLinkedFolder, setHasLinkedFolder] = useState(() => getCachedHandle(workspaceId) !== null);

  /* Local-file transport: daemon (works over HTTP — the VM case) preferred,
     browser FS API fallback (HTTPS/localhost). */
  const [cap, setCap] = useState<{ agent: boolean; fsApi: boolean }>({ agent: false, fsApi: false });
  const [agentPath, setAgentPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const useFsApi = cap.fsApi && !cap.agent;

  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      const c = await getCapability().catch(() => ({ agent: false, fsApi: isFsApiAvailable() }));
      if (!cancelled) setCap({ agent: c.agent, fsApi: c.fsApi });
    };
    void detect();
    const onFocus = () => { void detect(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, []);

  /* Git state */
  const [repoUrl,     setRepoUrl]     = useState("");
  const [gitProvider,  setGitProvider]  = useState<GitProvider>("github");
  const [branch,       setBranch]       = useState("main");
  const [branches,     setBranches]     = useState<string[]>([]);
  const [patToken,     setPatToken]     = useState("");
  const [cloning,      setCloning]      = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);

  const inputCls =
    "w-full h-8 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2.5 text-xs text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500";

  /* ── Local folder ──────────────────────────────────────────────────── */
  const handlePickFolder = async () => {
    try {
      const handle = await pickDirectory();
      setScanning(true);
      setError("");
      const nodes = await scanDirectory(handle);
      await replaceNodes(workspaceId, nodes);
      await storeDirectoryHandle(workspaceId, handle);
      cacheHandle(workspaceId, handle);
      setHasLinkedFolder(true);
      bumpTreeRevision();
      setStatus(`${nodes.filter((n) => n.type === "file").length} files imported from ${handle.name}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Could not open folder.");
    } finally {
      setScanning(false);
    }
  };

  /* ── Daemon: open the native OS folder dialog + fill the path ─────────── */
  const handleAgentBrowse = async () => {
    try {
      setBrowsing(true);
      const picked = await agentClient.pickFolder();
      if (picked) setAgentPath(picked);
    } finally {
      setBrowsing(false);
    }
  };

  /* ── Daemon: link an existing folder by absolute path (scan only) ─────── */
  const handleAgentLink = async () => {
    const p = stripQuotes(agentPath.trim()).trim();
    if (!p || !isValidFullPath(p)) { setError("Enter a valid absolute folder path."); return; }
    try {
      setScanning(true);
      setError("");
      const fa = await openAgentRoot(p);
      setWorkspaceFileAccess(workspaceId, fa);
      const nodes = await fa.scan();
      await replaceNodes(workspaceId, nodes);
      setHasLinkedFolder(true);
      bumpTreeRevision();
      setStatus(`${nodes.filter((n) => n.type === "file").length} files imported from ${fa.rootLabel}`);
    } catch (e) {
      setError(`Could not open folder via daemon: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  /* ── Daemon: write imported IDB files to a folder on disk ─────────────── */
  const handleAgentSaveToDisk = async () => {
    const p = stripQuotes(agentPath.trim()).trim();
    if (!p || !isValidFullPath(p)) { setError("Enter a valid absolute folder path."); return; }
    try {
      setSaving(true);
      setError("");
      const fa = await openAgentRoot(p, true); // mkdir-p if new
      setWorkspaceFileAccess(workspaceId, fa);
      const nodes = await getAllNodes(workspaceId);
      let written = 0;
      for (const node of nodes) {
        if (node.type !== "file") continue;
        const file = await getFile(workspaceId, node.path);
        if (!file || file.content === "(binary)") continue;
        await fa.write(node.path, file.content).catch(() => {});
        written++;
      }
      setHasLinkedFolder(true);
      bumpTreeRevision();
      setStatus(`${written} files saved to ${fa.rootLabel} (via daemon)`);
    } catch (e) {
      setError(`Could not save to folder via daemon: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  /* Reusable daemon path input + Browse row (shared by link & save-to-disk). */
  const agentPathRow = (
    <div className="flex items-center gap-1.5">
      <input
        value={agentPath}
        onChange={(e) => { setAgentPath(stripQuotes(e.target.value)); if (error) setError(""); }}
        placeholder="e.g. C:\\Users\\me\\projects\\my-app"
        className={`flex-1 ${inputCls} font-mono`}
      />
      <button type="button" onClick={handleAgentBrowse} disabled={browsing}
        title="Open a folder picker on your machine"
        className="inline-flex items-center gap-1 h-8 px-2 rounded-md border border-[var(--ide-border)] hover:border-violet-500 disabled:opacity-50 text-[10px] text-[var(--ide-muted)] hover:text-violet-300 transition-colors shrink-0">
        {browsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
        Browse
      </button>
    </div>
  );

  /* ── Git: auto-detect provider ─────────────────────────────────────── */
  const handleRepoUrlChange = (url: string) => {
    setRepoUrl(url);
    setError("");
    const detected = detectProvider(url);
    if (detected) setGitProvider(detected);
  };

  const handleFetchBranches = async () => {
    if (!repoUrl.trim()) return;
    setLoadingBranches(true);
    try {
      const list = await listBranches(repoUrl, gitProvider, patToken || undefined, selectedProjectId || undefined);
      setBranches(list);
      if (list.length > 0 && !list.includes(branch)) setBranch(list[0]);
    } catch { setBranches(["main"]); }
    finally { setLoadingBranches(false); }
  };

  const handleClone = async () => {
    if (!repoUrl.trim()) { setError("Repository URL is required."); return; }
    if (!selectedProjectId) { setError("No project selected. Select a project from the main app header."); return; }
    setCloning(true);
    setError("");
    setStatus(null);
    try {
      const response = await cloneRepo({
        repoUrl: repoUrl.trim(),
        branch,
        provider: gitProvider,
        patToken: patToken || undefined,
        projectId: selectedProjectId,
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
      const result = await writeSpecFilesToWorkspace(workspaceId, output);
      bumpTreeRevision();
      setStatus(`${result.fileCount} files cloned from ${extractRepoName(repoUrl)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  };

  /* ── Save imported files to a local folder on disk ───────────────── */
  const handleSaveToDisk = async () => {
    try {
      const handle = await pickDirectory();
      setSaving(true);
      setError("");
      const nodes = await getAllNodes(workspaceId);
      let written = 0;
      for (const node of nodes) {
        if (node.type !== "file") continue;
        const file = await getFile(workspaceId, node.path);
        if (!file || file.content === "(binary)") continue;
        await writeFsFile(handle, node.path, file.content).catch(() => {});
        written++;
      }
      await storeDirectoryHandle(workspaceId, handle);
      cacheHandle(workspaceId, handle);
      setHasLinkedFolder(true);
      bumpTreeRevision();
      setStatus(`${written} files saved to ${handle.name}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Could not save to folder.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full text-[var(--ide-text)]">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-[var(--ide-border)]">
        {([
          { id: "local"  as Tab, label: "Local",  Icon: FolderOpen },
          { id: "upload" as Tab, label: "Upload", Icon: Upload },
          { id: "git"    as Tab, label: "Git",    Icon: GitBranch },
        ]).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => { setTab(id); setError(""); setStatus(null); }}
            className={`flex-1 flex items-center justify-center gap-1 h-8 text-[10px] font-medium transition-colors ${
              tab === id
                ? "text-violet-300 border-b-2 border-violet-500"
                : "text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
            }`}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">

        {/* ── LOCAL ──────────────────────────────────────────── */}
        {tab === "local" && (
          <div className="space-y-3">
            <p className="text-[11px] text-[var(--ide-muted)]">
              Link a folder from your machine. Files are read directly from disk.
            </p>

            {cap.agent ? (
              /* Daemon path (works over HTTP — the VM case) */
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-[var(--ide-muted)]">
                  <Server className="h-3 w-3" /> LOCAL FOLDER PATH (via daemon)
                </label>
                {agentPathRow}
                {browsing && <p className="text-[10px] text-amber-400/90">A folder dialog opened on your machine — pick a folder (it may be behind this window).</p>}
                <button type="button" onClick={handleAgentLink} disabled={scanning}
                  className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-medium text-white transition-colors">
                  {scanning
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…</>
                    : <><FolderOpen className="h-3.5 w-3.5" /> Open folder via daemon</>}
                </button>
              </div>
            ) : useFsApi ? (
              <button
                type="button"
                onClick={handlePickFolder}
                disabled={scanning}
                className="w-full flex items-center justify-center gap-2 h-10 rounded-lg border border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors"
              >
                {scanning ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
                ) : (
                  <><FolderOpen className="h-4 w-4" /> Open Local Folder</>
                )}
              </button>
            ) : (
              <p className="text-[11px] text-[var(--ide-muted)] leading-relaxed">
                Local file access isn&apos;t connected. Open the{" "}
                <span className="text-[var(--ide-text)] font-medium">Daemon Setup</span> menu to connect the daemon
                (or use Chrome/Edge over HTTPS).
              </p>
            )}
          </div>
        )}

        {/* ── UPLOAD ─────────────────────────────────────────── */}
        {tab === "upload" && (
          <WorkspaceUploadZone
            workspaceId={workspaceId}
            onDone={({ fileCount }) => {
              bumpTreeRevision();
              setStatus(`${fileCount} files imported`);
            }}
          />
        )}

        {/* ── GIT ────────────────────────────────────────────── */}
        {tab === "git" && (
          <div className="space-y-2.5">
            {/* Repo URL */}
            <div>
              <label className="block text-[10px] font-medium text-[var(--ide-muted)] mb-1">Repository URL</label>
              <input
                value={repoUrl}
                onChange={(e) => handleRepoUrlChange(e.target.value)}
                placeholder={PROVIDER_INFO[gitProvider].placeholder}
                className={inputCls}
              />
            </div>

            {/* Provider chips */}
            <div className="flex gap-1">
              {(Object.keys(PROVIDER_INFO) as GitProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setGitProvider(p)}
                  className={`inline-flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium transition-colors ${
                    gitProvider === p
                      ? "bg-violet-600/20 text-violet-300 border border-violet-500/40"
                      : "text-[var(--ide-muted)] border border-[var(--ide-border)] hover:border-[var(--ide-muted)]"
                  }`}
                >
                  <Globe className="h-2.5 w-2.5" />
                  {PROVIDER_INFO[p].label}
                </button>
              ))}
            </div>

            {/* Branch */}
            <div>
              <label className="block text-[10px] font-medium text-[var(--ide-muted)] mb-1">Branch</label>
              <div className="flex gap-1.5">
                {branches.length > 0 ? (
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="flex-1 h-8 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2 text-xs text-[var(--ide-text)] focus:outline-none focus:ring-1 focus:ring-violet-500"
                  >
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                ) : (
                  <input value={branch} onChange={(e) => setBranch(e.target.value)}
                    placeholder="main" className={`flex-1 ${inputCls}`} />
                )}
                <button type="button" onClick={handleFetchBranches}
                  disabled={!repoUrl.trim() || loadingBranches}
                  className="h-8 px-2 rounded-md border border-[var(--ide-border)] text-[10px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] disabled:opacity-40 transition-colors"
                >
                  {loadingBranches ? <Loader2 className="h-3 w-3 animate-spin" /> : "Fetch"}
                </button>
              </div>
            </div>

            {/* PAT */}
            <div>
              <label className="block text-[10px] font-medium text-[var(--ide-muted)] mb-1">
                Token <span className="font-normal">(private repos)</span>
              </label>
              <div className="relative">
                <Key className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ide-muted)]" />
                <input type="password" value={patToken}
                  onChange={(e) => setPatToken(e.target.value)}
                  placeholder="ghp_xxxx" className={`${inputCls} pl-7`} />
              </div>
            </div>

            {/* Clone button */}
            <button type="button" onClick={handleClone}
              disabled={!repoUrl.trim() || cloning || !selectedProjectId}
              className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:brightness-110 disabled:opacity-50 text-xs font-medium text-white transition-all"
            >
              {cloning
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cloning…</>
                : <><GitBranch className="h-3.5 w-3.5" /> Clone &amp; Import</>}
            </button>
          </div>
        )}

        {/* Status / Error */}
        {error && (
          <p className="text-[11px] text-red-400 px-1">{error}</p>
        )}
        {status && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-emerald-950/30 border border-emerald-800/40">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            <p className="text-[11px] text-emerald-300">{status}</p>
          </div>
        )}

        {/* Save to disk (daemon) — shown after import when no folder is linked */}
        {status && !hasLinkedFolder && cap.agent && (
          <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2.5 space-y-2">
            <p className="text-[11px] font-medium text-amber-300">Save imported files to your disk (via daemon)</p>
            <p className="text-[10px] text-[var(--ide-muted)] leading-relaxed">
              Choose the local folder where the daemon should write these files. This also links it for future edits.
            </p>
            {agentPathRow}
            <button
              type="button"
              onClick={handleAgentSaveToDisk}
              disabled={saving}
              className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors"
            >
              {saving
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving to disk…</>
                : <><Server className="h-3 w-3" /> Save to disk via daemon</>}
            </button>
          </div>
        )}

        {/* Save to disk (FS API) — HTTPS/localhost fallback */}
        {status && !hasLinkedFolder && useFsApi && (
          <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2.5 space-y-2">
            <p className="text-[11px] font-medium text-amber-300">Files are in browser storage only</p>
            <p className="text-[10px] text-[var(--ide-muted)] leading-relaxed">
              Pick a local folder to save the imported files to disk. This also links the folder for future edits.
            </p>
            <button
              type="button"
              onClick={handleSaveToDisk}
              disabled={saving}
              className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors"
            >
              {saving
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving to disk…</>
                : <><FolderOpen className="h-3 w-3" /> Save to local folder</>}
            </button>
          </div>
        )}

        {/* Linked folder indicator */}
        {hasLinkedFolder && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-950/20 border border-emerald-800/30">
            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
            <p className="text-[10px] text-emerald-300">Local folder linked — files sync to disk</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default SourceConnectorPanel;
