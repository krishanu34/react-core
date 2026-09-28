"use client";

/**
 * StatusBar — bottom bar: git branch, sync status, full active-file path (AC5),
 * cursor position. ISOLATION: new file under components/ide/.
 * (The project-model pill moved into the chat composer beside Send — see
 * ChatDock's model dropdown.)
 */
import React from "react";
import { GitBranch, RefreshCw, CheckCircle2, CloudOff, AlertTriangle, Loader2, UploadCloud } from "lucide-react";
import { ideClasses } from "@/lib/design-tokens";
import type { SyncStatus } from "@/providers/WorkspaceProvider";

const SYNC_UI: Record<SyncStatus, { icon: React.ReactNode; label: string; color: string }> = {
  idle: { icon: <RefreshCw className="h-3 w-3" />, label: "Idle", color: "text-[var(--ide-muted)]" },
  syncing: { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: "Saving…", color: "text-amber-400" },
  synced: { icon: <CheckCircle2 className="h-3 w-3" />, label: "Synced", color: "text-emerald-400" },
  offline: { icon: <CloudOff className="h-3 w-3" />, label: "Offline", color: "text-[var(--ide-muted)]" },
  conflict: { icon: <AlertTriangle className="h-3 w-3" />, label: "Conflict", color: "text-orange-400" },
  error: { icon: <AlertTriangle className="h-3 w-3" />, label: "Error", color: "text-red-400" },
};

/* ========================================================================== *
 *  StatusBar — branch · sync state · full active-file path · cursor · language
 * ========================================================================== */
export function StatusBar({
  branch = "main",
  syncStatus,
  fullPath,
  line,
  column,
  language,
  pendingOps = 0,
}: {
  branch?: string;
  syncStatus: SyncStatus;
  fullPath?: string | null;
  line?: number;
  column?: number;
  language?: string;
  /** Outbox operations queued for server sync — visible so it's not a silent black box. */
  pendingOps?: number;
}) {
  const sync = SYNC_UI[syncStatus];
  return (
    <footer className="relative flex justify-center py-1.5 shrink-0">
      <div className="ide-status-gradient-border inline-flex items-center gap-3 h-6 px-4 rounded-full bg-[var(--ide-glass)] backdrop-blur-md text-[10px] text-[var(--ide-text)] shadow-lg">
        <span className="inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" /> {branch}
        </span>
        <span className="w-px h-3 bg-[var(--ide-border)]" />
        <span className={`inline-flex items-center gap-1 ${sync.color}`}>
          {sync.icon} {sync.label}
        </span>
        {fullPath && (
          <>
            <span className="w-px h-3 bg-[var(--ide-border)]" />
            <span className="truncate max-w-[30vw]" title={fullPath}>
              {fullPath}
            </span>
          </>
        )}
        {language && (
          <>
            <span className="w-px h-3 bg-[var(--ide-border)]" />
            <span>{language}</span>
          </>
        )}
        {pendingOps > 0 && (
          <>
            <span className="w-px h-3 bg-[var(--ide-border)]" />
            <span
              className="inline-flex items-center gap-1 text-amber-400"
              title={`${pendingOps} change${pendingOps === 1 ? "" : "s"} queued for server sync`}
            >
              <UploadCloud className="h-3 w-3" /> {pendingOps}
            </span>
          </>
        )}
      </div>
    </footer>
  );
}

export default StatusBar;
