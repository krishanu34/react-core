"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  ArrowLeft,
  Save,
  FolderOpen,
  Loader2,
  CheckCircle2,
  Trash2,
  AlertTriangle,
} from "lucide-react";
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
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";
import { archiveWorkspace, updateWorkspace } from "@/lib/workspace-api";

/* ========================================================================== *
 *  Workspace Edit Page  — /workspaces/[id]/edit
 *
 *  For LOCAL workspaces: edit name, description, path label, linked folder.
 *  Picking a new folder clears stale IDB file content and rescans so the
 *  explorer always reflects the live directory.
 *  Saving persists to IndexedDB; WorkspaceProvider re-reads on next IDE load
 *  so the TopBar path label updates automatically.
 * ========================================================================== */

const inputCls =
  "w-full h-10 rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent transition";
const labelCls = "block text-xs font-medium text-slate-300 mb-1.5";

export default function WorkspaceEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const wsId = Number(params.id);
  const isLocal = isLocalWorkspaceId(wsId);

  const [name,           setName]          = useState("");
  const [description,    setDescription]   = useState("");
  const [localPathLabel, setLocalPathLabel] = useState("");
  const [linkedFolder,   setLinkedFolder]  = useState<string | null>(null);
  const [loading,        setLoading]       = useState(true);
  const [saving,         setSaving]        = useState(false);
  const [saved,          setSaved]         = useState(false);
  const [nameError,      setNameError]     = useState("");
  const [scanning,       setScanning]      = useState(false);
  const [scanCount,      setScanCount]     = useState<number | null>(null);
  const [showDelete,     setShowDelete]    = useState(false);
  const [deleting,       setDeleting]      = useState(false);

  useEffect(() => {
    if (!canAccessWorkspaceStudio()) router.replace("/");
  }, [router]);

  // Load workspace metadata from IDB
  useEffect(() => {
    if (!isLocal) { setLoading(false); return; }
    getLocalWorkspace(wsId)
      .then((ws) => {
        if (!ws) { router.replace("/workspaces"); return; }
        setName(ws.name ?? "");
        setDescription(ws.description ?? "");
        setLocalPathLabel(ws.localPathLabel ?? "");
      })
      .catch(() => router.replace("/workspaces"))
      .finally(() => setLoading(false));
  }, [wsId, isLocal, router]);

  // Check whether a folder handle is already linked for this workspace
  useEffect(() => {
    if (!isLocal || !isFsApiAvailable()) return;
    getDirectoryHandle(wsId)
      .then(async (h) => {
        if (!h) return;
        const ok = await requestPermission(h, "read").catch(() => false);
        if (ok) setLinkedFolder(h.name);
      })
      .catch(() => {});
  }, [wsId, isLocal]);

  // Pick (or change) the local folder linked to this workspace.
  // Always: updates localPathLabel, clears stale IDB data, rescans directory.
  const handlePickFolder = async () => {
    try {
      const handle = await pickDirectory();
      // Persist handle and warm the module-level cache
      await storeDirectoryHandle(wsId, handle);
      cacheHandle(wsId, handle);
      // Update UI immediately so the linked-folder card shows while scanning
      setLinkedFolder(handle.name);
      // Always update path label to the new folder name (user can override in the field below)
      setLocalPathLabel(handle.name);
      if (!name) setName(handle.name);
      // Clear stale file content from the old folder, then rescan
      setScanning(true);
      setScanCount(null);
      await clearWorkspaceFiles(wsId).catch(() => {});
      const nodes = await scanDirectory(handle);
      await replaceNodes(wsId, nodes).catch(() => {});
      setScanCount(nodes.filter((n) => n.type === "file").length);
    } catch (e) {
      if ((e as Error).name !== "AbortError") window.alert("Could not open folder.");
      // Don't reset linkedFolder — user may have just cancelled the picker
    } finally {
      setScanning(false);
    }
  };

  const handleUnlinkFolder = async () => {
    await removeDirectoryHandle(wsId).catch(() => {});
    setLinkedFolder(null);
    setScanCount(null);
  };

  // Persist name / description / localPathLabel to IDB.
  // WorkspaceProvider re-reads on next IDE navigation so TopBar updates.
  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setNameError("Workspace name is required."); return; }
    setNameError("");
    setSaving(true);
    setSaved(false);
    try {
      if (isLocal) {
        const current = await getLocalWorkspace(wsId);
        if (!current) throw new Error("Workspace not found");
        await updateWorkspace(wsId, {
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
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      window.alert("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      if (isLocal) {
        await archiveWorkspace(wsId, name);
        await deleteLocalWorkspace(wsId);
        await removeDirectoryHandle(wsId).catch(() => {});
      }
      router.replace("/workspaces");
    } catch {
      window.alert("Failed to delete workspace.");
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-700 text-slate-400 hover:text-slate-100 hover:border-slate-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold truncate">Workspace Settings</h1>
            <p className="text-[11px] text-slate-500 mt-0.5 truncate">{name || "Untitled"}</p>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || scanning}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-300" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">

        {/* Server workspace notice */}
        {!isLocal && (
          <div className="rounded-lg border border-amber-800/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
            This is a server-managed workspace. Name and settings are managed through the project settings.
          </div>
        )}

        {/* Name */}
        <div>
          <label className={labelCls}>
            Workspace Name <span className="text-red-400">*</span>
          </label>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); if (nameError) setNameError(""); }}
            placeholder="e.g. Auth Microservice"
            disabled={!isLocal}
            className={`${inputCls} ${nameError ? "border-red-500 focus:ring-red-500" : ""} disabled:opacity-50 disabled:cursor-not-allowed`}
          />
          {nameError && <p className="mt-1 text-xs text-red-400">{nameError}</p>}
        </div>

        {/* Description */}
        <div>
          <label className={labelCls}>
            Description <span className="text-slate-500 font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this workspace…"
            disabled={!isLocal}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed resize-none transition"
          />
        </div>

        {/* Local folder — local workspaces only */}
        {isLocal && (
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-4">
            <div>
              <h2 className="text-sm font-medium text-slate-200">Local Folder</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Connect a folder on your machine so the workspace reads and writes files directly.
                Changing the folder rescans the file tree and syncs IDB to the new location.
              </p>
            </div>

            {linkedFolder ? (
              /* Linked folder card — shows scanning progress inline */
              <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-800/40 space-y-2">
                <div className="flex items-center gap-3">
                  {scanning ? (
                    <Loader2 className="h-4 w-4 text-emerald-400 shrink-0 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-emerald-300 truncate">{linkedFolder}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {scanning
                        ? "Scanning directory and syncing to local storage…"
                        : scanCount !== null
                          ? `${scanCount} file${scanCount !== 1 ? "s" : ""} indexed`
                          : "Folder connected — file tree synced on workspace open"}
                    </p>
                  </div>
                  {!scanning && (
                    <div className="flex items-center gap-2 shrink-0">
                      {isFsApiAvailable() && (
                        <button
                          type="button"
                          onClick={handlePickFolder}
                          className="text-xs text-slate-400 hover:text-slate-200 underline"
                        >
                          Change
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleUnlinkFolder}
                        className="text-xs text-red-400 hover:text-red-300 underline"
                      >
                        Unlink
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              isFsApiAvailable() ? (
                <button
                  type="button"
                  onClick={handlePickFolder}
                  disabled={scanning}
                  className="w-full flex items-center justify-center gap-2 h-11 rounded-lg border border-dashed border-slate-600 hover:border-violet-500 hover:bg-violet-600/5 text-sm text-slate-400 hover:text-violet-300 disabled:opacity-50 transition-colors"
                >
                  <FolderOpen className="h-4 w-4" />
                  Connect Local Folder
                </button>
              ) : (
                <p className="text-xs text-slate-500 italic">
                  File System Access API is not available in this browser. Use Chrome or Edge 86+ to link a local folder.
                </p>
              )
            )}

            {/* Path label — editable override for what appears in the workspace TopBar */}
            <div>
              <label className={labelCls}>
                Path Label{" "}
                <span className="text-slate-500 font-normal">
                  (displayed in workspace header — auto-filled from folder name)
                </span>
              </label>
              <input
                value={localPathLabel}
                onChange={(e) => setLocalPathLabel(e.target.value)}
                placeholder="e.g. ~/projects/auth-service"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                You can type a custom path (e.g. the absolute OS path) so the TopBar reflects
                where files are stored on your machine.
              </p>
            </div>
          </div>
        )}

        {/* Danger zone */}
        {isLocal && (
          <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 space-y-3">
            <div>
              <h2 className="text-sm font-medium text-red-300">Danger Zone</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Removes this workspace from Workspace Studio. Your local files are <em>not</em> deleted.
              </p>
            </div>

            {!showDelete ? (
              <button
                type="button"
                onClick={() => setShowDelete(true)}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border border-red-800 text-sm text-red-400 hover:bg-red-950/50 hover:text-red-300 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Delete Workspace
              </button>
            ) : (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-red-950/40 border border-red-800/60">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                <p className="flex-1 text-xs text-red-300">This cannot be undone. Are you sure?</p>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs font-medium text-white transition-colors"
                >
                  {deleting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {deleting ? "Deleting…" : "Yes, Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDelete(false)}
                  className="h-7 px-3 rounded-md border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
