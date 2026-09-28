"use client";

/**
 * Setup Guide tab — instructions & prerequisites for configuring and using
 * Workspaces. Purely informational: daemon install/start/stop/uninstall all
 * live on the Daemon Setup page; this page just explains the flow and routes
 * the user there. Always accessible, even while the daemon is disconnected.
 */

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen, Server, FolderGit2, ShieldCheck, CheckCircle2, ArrowRight, Monitor, UserCheck, Globe,
} from "lucide-react";
import { useDaemonStatus } from "@/lib/hooks/useDaemonStatus";
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";

function Step({
  n, title, children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600/20 text-[11px] font-semibold text-violet-300 mt-0.5">
        {n}
      </div>
      <div>
        <p className="text-xs font-medium text-slate-200">{title}</p>
        <div className="mt-1 text-[11px] text-slate-500 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export default function WorkspaceSetupGuidePage() {
  const router = useRouter();
  const { connected } = useDaemonStatus();

  useEffect(() => {
    if (!canAccessWorkspaceStudio()) router.replace("/");
  }, [router]);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-violet-400" /> Workspace Setup Guide
        </h1>
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">
          A Workspace lets DevAccel&apos;s AI agents read and edit code that stays on{" "}
          <span className="text-slate-400">your machine</span>. A small local daemon bridges the
          browser and your files — nothing is uploaded unless you explicitly share it.
        </p>
      </div>

      {/* Prerequisites */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <p className="text-xs font-medium text-slate-300">Prerequisites</p>
        <ul className="mt-2 space-y-1.5 text-[11px] text-slate-500 leading-relaxed">
          <li className="flex items-start gap-2">
            <UserCheck className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" />
            A DevAccel account with the Workspace Studio role (you have it — you can see this page).
          </li>
          <li className="flex items-start gap-2">
            <Monitor className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" />
            A Windows machine where you can run a downloaded program. No admin rights are
            required — the daemon installs per-user. (macOS and Linux support is coming soon.)
          </li>
          <li className="flex items-start gap-2">
            <Globe className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" />
            A modern browser on the same machine as your code — the daemon only ever listens on
            127.0.0.1, so browser and files must be together.
          </li>
        </ul>
      </div>

      {/* Steps */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-4">
        <p className="text-xs font-medium text-slate-300">Getting started</p>

        <Step n={1} title="Install & connect the daemon">
          Go to <span className="text-slate-400">Daemon Setup</span>, download the daemon and run it
          once. It installs itself, starts in the background, and auto-starts on every future
          sign-in. All daemon operations — install, start, stop, uninstall, status — live on that
          page.
        </Step>

        <Step n={2} title="Wait for the status to turn green">
          The status bar (top right) and the dot next to <span className="text-slate-400">Daemon
          Setup</span> in the sidebar show the live connection. The{" "}
          <span className="text-slate-400">Workspaces</span> menu enables automatically the moment
          the daemon connects — no refresh needed. After a computer restart the daemon comes back on
          its own; on managed machines that can take a few moments after you sign in.
        </Step>

        <Step n={3} title="Create a workspace">
          Open <span className="text-slate-400">Workspaces</span> and create a new workspace by
          picking a folder on your machine (or uploading files). The daemon indexes it locally.
        </Step>

        <Step n={4} title="Work in the IDE">
          Open the workspace to launch the browser IDE — browse and edit files, chat with agents,
          and run spec-driven executions against your local code.
        </Step>
      </div>

      {/* Security */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <p className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Security
        </p>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-500 leading-relaxed list-disc pl-4">
          <li>The daemon binds to 127.0.0.1 only — it is never reachable from another machine.</li>
          <li>Only this app&apos;s origin may talk to it, and every request needs a pairing token
            issued after your DevAccel session is verified.</li>
          <li>File access is sandboxed to the folders you explicitly register as workspaces.</li>
        </ul>
      </div>

      {/* Status-aware CTA */}
      {connected ? (
        <button
          type="button"
          onClick={() => router.push("/workspaces")}
          className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-violet-600 hover:bg-violet-500 text-[12px] font-medium text-white transition-colors"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Daemon connected — open Workspaces
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => router.push("/workspaces/setup")}
          className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-violet-600 hover:bg-violet-500 text-[12px] font-medium text-white transition-colors"
        >
          <Server className="h-3.5 w-3.5" /> Go to Daemon Setup
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}

      <p className="text-[10px] text-slate-600 flex items-center gap-1.5">
        <FolderGit2 className="h-3 w-3" /> The Workspaces menu stays disabled until the daemon is
        installed and connected.
      </p>
    </div>
  );
}
