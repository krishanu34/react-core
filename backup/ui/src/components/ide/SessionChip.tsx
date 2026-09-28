"use client";

/**
 * SessionChip — shows the active session for the current workspace (AC9).
 * ISOLATION: new file under components/ide/.
 */
import React from "react";
import { MessageSquare } from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";

/* ========================================================================== *
 *  SessionChip — shows the active session for the current workspace (AC9)
 * ========================================================================== */
export function SessionChip() {
  const { activeSession } = useWorkspace();
  return (
    <div className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--ide-surface-2)] border border-[var(--ide-border)] text-xs text-[var(--ide-text)]">
      <MessageSquare className="h-3.5 w-3.5 text-violet-400" />
      <span className="text-[var(--ide-muted)]">Session:</span>
      <span className="font-medium text-[var(--ide-text)] truncate max-w-[200px]">
        {activeSession?.name ?? "—"}
      </span>
    </div>
  );
}

export default SessionChip;
