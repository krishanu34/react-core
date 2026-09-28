"use client";

/**
 * /workspaces — Local workspace listing.
 *
 * Lists workspaces stored in IndexedDB (no backend required). Each workspace
 * card shows the name, description, creation date, and lets the user open the
 * workspace or delete it.
 *
 * Integration note: when backend workspace APIs become available, this page
 * can merge server workspaces into the same list by fetching alongside the
 * local ones and normalising into a shared type.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderGit2,
  PlusCircle,
  Trash2,
  ExternalLink,
  Calendar,
  FolderOpen,
  Loader2,
  History,
} from "lucide-react";
import {
  deleteLocalWorkspace,
  getLastActive,
  getLocalWorkspace,
  type LocalWorkspace,
} from "@/lib/db/workspaceStore";
import { archiveWorkspace, listWorkspaces } from "@/lib/workspace-api";
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";
import { agentClient } from "@/lib/fileAccess";
import { buildWorkspaceList, cleanPath, displayName } from "@/lib/workspace-list";
import { cn } from "@/lib/utils";

/**
 * List item = server metadata + per-machine visibility.
 * onThisMachine: true/false when the daemon verified the folder path on this
 * machine; undefined when it can't be determined (daemon down / old build) —
 * undetermined workspaces are always shown (never a silent hide).
 */
type WsListItem = LocalWorkspace & { onThisMachine?: boolean };

/* ========================================================================== */
function WorkspaceCard({
  ws,
  onOpen,
  onDelete,
}: {
  ws: WsListItem;
  onOpen: () => void;
  onDelete: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // A row with no name still names a folder — show the folder instead of a
  // meaningless "Untitled" card (see lib/workspace-list).
  const title = displayName(ws);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:border-violet-700/50 transition-colors">
      {/* Title row */}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <FolderGit2 className="h-4.5 w-4.5 text-violet-400 shrink-0" />
          {/* Agent-created workspaces carry no name (the DB default is ''); the
              folder name stands in for it, so "Untitled" is a last resort. */}
          <span
            className={cn(
              "truncate font-medium",
              ws.name ? "text-slate-100" : "italic text-slate-300",
            )}
            title={ws.localPathLabel || title}
          >
            {title || "Untitled workspace"}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-500 font-mono">
          local
        </span>
      </div>

      {/* Description */}
      {ws.description && (
        <p className="text-xs text-slate-400 line-clamp-2 -mt-1">{ws.description}</p>
      )}

      {/* Meta */}
      <div className="flex items-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {new Date(ws.createdAt).toLocaleDateString()}
        </span>
        {ws.localPathLabel && (
          <span className="truncate max-w-[180px] font-mono">{ws.localPathLabel}</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-slate-800">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open Workspace
        </button>

        {confirming ? (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-red-400">Delete workspace?</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-red-600 hover:bg-red-500 text-xs text-white disabled:opacity-50 transition-colors"
            >
              {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-7 px-2.5 rounded-md border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Delete workspace"
            className="ml-auto h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
export default function WorkspacesPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastActiveId, setLastActiveId] = useState<number | null>(null);
  // Rows the server returned that are not openable workspaces (agent chat
  // threads with no folder) — reported, not silently swallowed.
  const [skipped, setSkipped] = useState(0);

  // Read the last-opened workspace so we can offer to resume it on startup /
  // refresh (AC: workspace state recovery — active workspace is restored).
  useEffect(() => {
    getLastActive()
      .then((la) => setLastActiveId(la?.workspaceId ?? null))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // No project gate: the backend scopes to the signed-in user via the JWT.
      const list = await listWorkspaces();
      const rows: WsListItem[] = list
        .filter((w) => !w.archived)
        .map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          localPathLabel: w.localPathLabel,
          createdAt: w.createdAt ?? Date.now(),
          fileCount: 0,
        }));

      // THIS machine's IndexedDB record wins over server metadata — it's what
      // the relink flow updates — so resolve it BEFORE filtering on the path.
      await Promise.all(
        rows.map(async (w) => {
          const local = await getLocalWorkspace(w.id).catch(() => null);
          if (local?.localPathLabel) w.localPathLabel = local.localPathLabel;
        }),
      );

      // Drop agent chat-thread rows (no folder) and collapse rows that point at
      // the same folder — see lib/workspace-list for why the table holds both.
      const { items, droppedPathless, mergedDuplicates } = buildWorkspaceList(rows);
      setSkipped(droppedPathless + mergedDuplicates);

      // Per-machine visibility: a workspace's folder lives on ONE machine, so
      // check each path against the local daemon (read-only /fs/exists) and
      // hide foreign ones.
      const effectivePaths = items.map((w) => cleanPath(w.localPathLabel));
      const uniquePaths = [...new Set(effectivePaths)];
      // null = can't determine (daemon down / older build) → leave everything
      // visible rather than hiding workspaces on a failed probe.
      const exists = uniquePaths.length > 0 ? await agentClient.pathsExist(uniquePaths) : {};
      if (exists) {
        items.forEach((w, i) => {
          const p = effectivePaths[i];
          if (typeof exists[p] === "boolean") w.onThisMachine = exists[p];
        });
      }

      setWorkspaces(items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canAccessWorkspaceStudio()) router.replace("/");
  }, [router]);

  useEffect(() => { load(); }, [load]);

  // Strict per-machine view: workspaces whose folder is on another machine
  // are never listed here (open that machine to see them).
  const visibleWorkspaces = workspaces.filter((w) => w.onThisMachine !== false);
  const hiddenCount = workspaces.length - visibleWorkspaces.length;

  // Only offer resume when the last-opened workspace is visible in the list.
  const resumeWs = lastActiveId != null
    ? visibleWorkspaces.find((w) => w.id === lastActiveId) ?? null
    : null;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Workspaces</h1>
          <p className="mt-1 text-xs text-slate-500">
            Workspaces whose folder is on this machine. Files stay local.
            {(hiddenCount > 0 || skipped > 0) && (
              <>
                {" "}
                <span className="text-slate-600">
                  ({[
                    hiddenCount > 0 ? `${hiddenCount} on other machines` : null,
                    skipped > 0 ? `${skipped} chat-only` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}{" "}
                  not shown)
                </span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/workspaces/new")}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors"
        >
          <PlusCircle className="h-4 w-4" /> New Workspace
        </button>
      </div>

      {/* Resume last-opened workspace (session/state recovery) */}
      {resumeWs && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-violet-800/50 bg-violet-950/20 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <History className="h-4 w-4 text-violet-400 shrink-0" />
            <p className="text-xs text-slate-300 truncate">
              Resume where you left off —{" "}
              <span className="font-medium text-slate-100">{displayName(resumeWs)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push(`/workspaces/${resumeWs.id}/ide`)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white transition-colors shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Resume
          </button>
        </div>
      )}

      {/* Notice */}
      {/* <div className="flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300/80">
          These workspaces are stored locally in your browser&apos;s IndexedDB. Once backend
          workspace management APIs are available, they will appear here alongside
          server-synced workspaces — no UI changes needed.
        </p>
      </div> */}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 h-40 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading workspaces…
        </div>
      ) : visibleWorkspaces.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-slate-800 py-16">
          <FolderOpen className="h-10 w-10 text-slate-700" />
          <div className="text-center">
            <p className="text-sm font-medium text-slate-400">
              {hiddenCount > 0 ? "No workspaces on this machine" : "No workspaces yet"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {hiddenCount > 0
                ? `${hiddenCount} workspace${hiddenCount === 1 ? " exists" : "s exist"} on other machines and ${hiddenCount === 1 ? "is" : "are"} not shown here. Create a new workspace on this machine.`
                : skipped > 0
                  ? `Your account has ${skipped} chat thread${skipped === 1 ? "" : "s"} with no workspace folder — those aren't openable here. Create a workspace to start building.`
                  : "Create one to start exploring files in your workspace."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push("/workspaces/new")}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors"
          >
            <PlusCircle className="h-4 w-4" /> New Workspace
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleWorkspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              ws={ws}
              onOpen={() => router.push(`/workspaces/${ws.id}/ide`)}
              onDelete={async () => {
                await archiveWorkspace(ws.id, ws.name);
                await deleteLocalWorkspace(ws.id).catch(() => {});
                await load();
              }}
            />
          ))}

          {/* New workspace tile */}
          <button
            type="button"
            onClick={() => router.push("/workspaces/new")}
            className="group flex min-h-[140px] items-center justify-center rounded-xl border-2 border-dashed border-slate-800 hover:border-violet-600/50 hover:bg-violet-600/5 transition-colors"
          >
            <div className="flex flex-col items-center gap-2 text-slate-600 group-hover:text-violet-400 transition-colors">
              <PlusCircle className="h-6 w-6" />
              <span className="text-xs font-medium">New Workspace</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
