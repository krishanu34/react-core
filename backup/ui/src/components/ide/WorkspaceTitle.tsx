"use client";

/**
 * WorkspaceTitle — shows the CURRENT workspace name in the IDE title bar.
 *
 * A workspace is its own project; the IDE is opened for one workspace and takes
 * over the full screen. This intentionally does NOT list other projects/
 * workspaces — it only identifies the one currently open, with a back link to
 * the chooser.
 */
import React from "react";
import Link from "next/link";
import { ChevronLeft, FolderGit2 } from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";

/* ========================================================================== *
 *  WorkspaceTitle — current workspace name + back link (no project listing)
 * ========================================================================== */
export function WorkspaceTitle() {
  const { workspaceName, loading } = useWorkspace();
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/projects"
        title="Back to workspaces"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)] transition-colors"
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>
      <div className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--ide-surface-2)] border border-[var(--ide-border)]">
        <FolderGit2 className="h-3.5 w-3.5 text-violet-400" />
        <span className="text-xs font-medium text-[var(--ide-text)] truncate max-w-[240px]">
          {loading && !workspaceName ? "Loading…" : workspaceName || "Workspace"}
        </span>
      </div>
    </div>
  );
}

export default WorkspaceTitle;
