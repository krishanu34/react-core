"use client";

/**
 * WorkspaceSettingsModal — in-IDE settings panel for the current workspace.
 *
 * Opens as an overlay inside the IDE (no page navigation required).
 * After saving, calls refreshLocalMeta() so the TopBar and context update
 * immediately without a reload.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  X,
  Save,
  FolderOpen,
  Loader2,
  CheckCircle2,
  Trash2,
  AlertTriangle,
  Settings2,
  MapPin,
  Server,
} from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import {
  getCapability,
  openAgentRoot,
  setWorkspaceFileAccess,
  agentClient,
} from "@/lib/fileAccess";
import {
  getLocalWorkspace,
  updateLocalWorkspace,
  deleteLocalWorkspace,
  replaceNodes,
  clearWorkspaceFiles,
  isLocalWorkspaceId,
} from "@/lib/db/workspaceStore";
import {
  isFsApiAvailable,
  pickDirectory,
  scanDirectory,
  storeDirectoryHandle,
  cacheHandle,
  getDirectoryHandle,
  requestPermission,
  removeDirectoryHandle,
} from "@/lib/localFs";
import { archiveWorkspace, updateWorkspace } from "@/lib/workspace-api";

interface Props {
  open: boolean;
  onClose: () => void;
}

const inputCls =
  "w-full h-9 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-3 text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 transition";
const labelCls = "block text-[11px] font-medium text-[var(--ide-muted)] mb-1";

const stripQuotes = (p: string): string => p.replace(/^["']+|["']+$/g, "");
const isValidFullPath = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || /^\\\\/.test(p);

export function WorkspaceSettingsModal({ open, onClose }: Props) {
  const router = useRouter();
  const { workspaceId, refreshLocalMeta, fsHandle: ctxHandle, bumpTreeRevision } = useWorkspace();
  const isLocal = workspaceId != null && isLocalWorkspaceId(workspaceId);

  /* form state */
  const [name,           setName]          = useState("");
  const [description,    setDescription]   = useState("");
  const [localPathLabel, setLocalPathLabel] = useState("");
  const [linkedFolder,   setLinkedFolder]  = useState<string | null>(null);
  const [nameError,      setNameError]     = useState("");

  /* async op state */
  const [loading,   setLoading]   = useState(false);
  const [scanning,  setScanning]  = useState(false);
  const [scanCount, setScanCount] = useState<number | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [deleting,  setDeleting]  = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  /* Daemon transport (works over HTTP — the VM case) */
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentPath, setAgentPath] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);

  /* Load fresh metadata from IDB each time the modal opens */
  useEffect(() => {
    if (!open || workspaceId == null || !isLocal) return;
    setLoading(true);
    setShowDelete(false);
    setSaved(false);
    setNameError("");
    setScanCount(null);
    setLinkedFolder(null);
    setScanning(false);

    getLocalWorkspace(workspaceId)
      .then((ws) => {
        setName(ws?.name ?? "");
        setDescription(ws?.description ?? "");
        setLocalPathLabel(ws?.localPathLabel ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // Detect the local daemon (works over HTTP — the VM case).
    setAgentPath("");
    getCapability()
      .then((c) => setAgentAvailable(c.agent))
      .catch(() => setAgentAvailable(false));

    // Detect current linked folder
    if (isFsApiAvailable()) {
      // Prefer the live context handle (already permission-granted this session)
      if (ctxHandle) {
        setLinkedFolder(ctxHandle.name);
      } else {
        getDirectoryHandle(workspaceId)
          .then(async (h) => {
            if (!h) return;
            const ok = await requestPermission(h, "read").catch(() => false);
            if (ok) setLinkedFolder(h.name);
          })
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);

  /* Esc to close */
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  /* ── Folder operations ────────────────────────────────────────────────── */
  const handlePickFolder = async () => {
    if (workspaceId == null) return;
    try {
      const handle = await pickDirectory();
      await storeDirectoryHandle(workspaceId, handle);
      cacheHandle(workspaceId, handle);
      setLinkedFolder(handle.name);
      setLocalPathLabel(handle.name); // always update path label to new folder
      setScanning(true);
      setScanCount(null);
      await clearWorkspaceFiles(workspaceId).catch(() => {});
      const nodes = await scanDirectory(handle);
      await replaceNodes(workspaceId, nodes).catch(() => {});
      bumpTreeRevision();
      setScanCount(nodes.filter((n) => n.type === "file").length);
    } catch (e) {
      if ((e as Error).name !== "AbortError") window.alert("Could not open folder.");
    } finally {
      setScanning(false);
    }
  };

  const handleUnlinkFolder = async () => {
    if (workspaceId == null) return;
    await removeDirectoryHandle(workspaceId).catch(() => {});
    setLinkedFolder(null);
    setScanCount(null);
  };

  /* ── Daemon: open the native folder dialog on the user's machine ───────── */
  const handleAgentBrowse = async () => {
    try {
      setBrowsing(true);
      const picked = await agentClient.pickFolder();
      if (picked) setAgentPath(picked);
    } finally {
      setBrowsing(false);
    }
  };

  /* ── Daemon: connect an absolute folder path via the local daemon ──────── */
  const handleAgentConnect = async () => {
    if (workspaceId == null) return;
    const p = stripQuotes(agentPath.trim()).trim();
    if (!p || !isValidFullPath(p)) {
      window.alert("Enter a valid absolute folder path (e.g. C:\\Users\\me\\projects\\app).");
      return;
    }
    try {
      setScanning(true);
      setScanCount(null);
      const fa = await openAgentRoot(p);
      setWorkspaceFileAccess(workspaceId, fa);
      setLinkedFolder(fa.rootLabel);
      setLocalPathLabel(p);
      await clearWorkspaceFiles(workspaceId).catch(() => {});
      const nodes = await fa.scan();
      await replaceNodes(workspaceId, nodes).catch(() => {});
      bumpTreeRevision();
      setScanCount(nodes.filter((n) => n.type === "file").length);
    } catch (e) {
      window.alert(`Could not connect folder via daemon: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  /* ── Save ─────────────────────────────────────────────────────────────── */
  const handleSave = async () => {
    if (workspaceId == null || !isLocal) return;
    const trimmed = name.trim();
    if (!trimmed) { setNameError("Name is required."); return; }
    setNameError("");
    setSaving(true);
    setSaved(false);
    try {
      const current = await getLocalWorkspace(workspaceId);
      if (!current) throw new Error("Workspace not found");
      await updateWorkspace(workspaceId, {
        name: trimmed,
        description: description.trim() || null,
        local_fs_path: localPathLabel.trim() || null,
      });
      await updateLocalWorkspace({
        ...current,
        name: trimmed,
        description: description.trim() || undefined,
        localPathLabel: localPathLabel.trim() || undefined,
      });
      // Push updates to context so TopBar refreshes immediately
      await refreshLocalMeta();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      window.alert("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  /* ── Delete ───────────────────────────────────────────────────────────── */
  const handleDelete = async () => {
    if (workspaceId == null || !isLocal) return;
    setDeleting(true);
    try {
      await archiveWorkspace(workspaceId, name);
      await deleteLocalWorkspace(workspaceId);
      await removeDirectoryHandle(workspaceId).catch(() => {});
      onClose();
      router.push("/workspaces");
    } catch {
      window.alert("Failed to delete workspace.");
      setDeleting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-lg mx-4 rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--ide-border)] shrink-0">
          <Settings2 className="h-4 w-4 text-violet-400 shrink-0" />
          <h2 className="text-sm font-semibold text-[var(--ide-text)] flex-1">Workspace Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
            </div>
          ) : (
            <>
              {/* Name */}
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

              {/* Description */}
              <div>
                <label className={labelCls}>Description</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description…"
                  className="w-full rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-3 py-2 text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none transition"
                />
              </div>

              {/* Local folder — local workspaces only */}
              {isLocal && (
                <div className="rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface)] p-3 space-y-3">
                  <p className="text-[11px] font-medium text-[var(--ide-muted)]">LOCAL FOLDER</p>

                  {linkedFolder ? (
                    <div className="rounded-md bg-emerald-950/30 border border-emerald-800/40 p-2.5">
                      <div className="flex items-center gap-2">
                        {scanning
                          ? <Loader2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 animate-spin" />
                          : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                        }
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-emerald-300 truncate">{linkedFolder}</p>
                          <p className="text-[10px] text-[var(--ide-muted)] mt-0.5">
                            {scanning
                              ? "Scanning and syncing to local storage…"
                              : scanCount !== null
                                ? `${scanCount} file${scanCount !== 1 ? "s" : ""} indexed`
                                : "Connected — rescanned on each IDE open"}
                          </p>
                        </div>
                        {!scanning && (
                          <div className="flex gap-2 shrink-0">
                            {isFsApiAvailable() && (
                              <button type="button" onClick={handlePickFolder}
                                className="text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] underline">
                                Change
                              </button>
                            )}
                            <button type="button" onClick={handleUnlinkFolder}
                              className="text-[11px] text-red-400 hover:text-red-300 underline">
                              Unlink
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : agentAvailable ? (
                    /* Daemon connect (works over HTTP — the VM case) */
                    <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] px-3 py-2.5 space-y-2">
                      <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-[var(--ide-muted)]">
                        <Server className="h-3 w-3" /> CONNECT FOLDER (via daemon)
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={agentPath}
                          onChange={(e) => setAgentPath(stripQuotes(e.target.value))}
                          placeholder="e.g. C:\\Users\\me\\projects\\my-app"
                          className="flex-1 h-8 rounded border border-[var(--ide-border)] bg-[var(--ide-bg)] px-2 text-[12px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono"
                        />
                        <button type="button" onClick={handleAgentBrowse} disabled={browsing}
                          title="Open a folder picker on your machine"
                          className="inline-flex items-center gap-1 h-8 px-2.5 rounded border border-[var(--ide-border)] hover:border-violet-500 disabled:opacity-50 text-[11px] text-[var(--ide-text)] hover:text-violet-300 transition-colors shrink-0">
                          {browsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                          Browse…
                        </button>
                      </div>
                      {browsing && <p className="text-[10px] text-amber-400/90">A folder dialog opened on your machine — pick a folder (it may be behind this window).</p>}
                      <button type="button" onClick={handleAgentConnect} disabled={scanning}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors">
                        {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                        {scanning ? "Connecting…" : "Connect folder via daemon"}
                      </button>
                    </div>
                  ) : isFsApiAvailable() ? (
                    <button type="button" onClick={handlePickFolder}
                      className="w-full flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-[var(--ide-border)] hover:border-violet-500 hover:bg-violet-600/5 text-xs text-[var(--ide-muted)] hover:text-violet-300 transition-colors">
                      <FolderOpen className="h-3.5 w-3.5" />
                      Connect Local Folder
                    </button>
                  ) : (
                    <p className="text-[11px] text-[var(--ide-muted)] italic">
                      Local file access isn&apos;t connected. Open the Daemon Setup page to connect the daemon (or use Chrome/Edge over HTTPS).
                    </p>
                  )}

                  {/* Full path shown in TopBar */}
                  <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] px-3 py-2.5">
                    <label className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] mb-1.5">
                      <MapPin className="h-3 w-3" />
                      FULL PATH — shown in IDE header
                    </label>
                    <input
                      value={localPathLabel}
                      onChange={(e) => setLocalPathLabel(e.target.value)}
                      placeholder={linkedFolder
                        ? `e.g. C:\\Users\\you\\Downloads\\${linkedFolder}`
                        : "e.g. C:\\Users\\you\\projects\\auth-service"}
                      className="w-full h-8 rounded border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2 text-[12px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono"
                    />
                    {linkedFolder && (
                      <p className="mt-1.5 text-[10px] text-[var(--ide-muted)] leading-relaxed">
                        Browser security can only read the folder name (<span className="font-mono">{linkedFolder}</span>).
                        Type the full path so it appears in the IDE header.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Danger zone */}
              {isLocal && (
                <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-3 space-y-2.5">
                  <p className="text-[11px] font-medium text-red-400">DANGER ZONE</p>
                  {!showDelete ? (
                    <button type="button" onClick={() => setShowDelete(true)}
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-red-800 text-xs text-red-400 hover:bg-red-950/50 transition-colors">
                      <Trash2 className="h-3 w-3" />
                      Delete Workspace
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 p-2 rounded-md bg-red-950/40 border border-red-800/60">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                      <p className="flex-1 text-[11px] text-red-300">
                        Delete permanently? Local files are <em>not</em> removed.
                      </p>
                      <button type="button" onClick={handleDelete} disabled={deleting}
                        className="inline-flex items-center gap-1 h-6 px-2.5 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-[11px] text-white transition-colors">
                        {deleting && <Loader2 className="h-3 w-3 animate-spin" />}
                        {deleting ? "Deleting…" : "Delete"}
                      </button>
                      <button type="button" onClick={() => setShowDelete(false)}
                        className="h-6 px-2.5 rounded border border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] transition-colors">
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--ide-border)] shrink-0">
          <button type="button" onClick={onClose}
            className="h-8 px-3 rounded-md border border-[var(--ide-border)] text-sm text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving || scanning || loading}
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
            {saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : saved
                ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                : <Save className="h-3.5 w-3.5" />
            }
            {saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default WorkspaceSettingsModal;
