"use client";

/**
 * Setup Daemon tab — the ONLY place daemon install/management lives.
 *
 * A browser can't launch or kill an OS process directly, so Install is guided
 * (download → run once; it then auto-starts on login). After that everything is
 * one-click: Start fires the devaccel:// protocol the installer registered
 * (native browser prompt), and Stop / Update / Uninstall are backed by the
 * daemon's authenticated /daemon/* endpoints. "Installed but stopped" is a
 * web-side heuristic (see lib/daemon-install-state.ts) — the disk is invisible
 * to a browser.
 */

import React, { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Server, ShieldCheck, Power, Trash2, Loader2, Copy, Check, RefreshCw, Download, Play, ArrowUpCircle,
  ArrowRight, BookOpen, FolderGit2,
} from "lucide-react";
import { DaemonDownloadButton } from "@/components/ide/DaemonDownloadButton";
import { useDaemonStatus } from "@/lib/hooks/useDaemonStatus";
import { agentClient } from "@/lib/fileAccess";
import { detectOS, getDaemonDownloadUrl, getLatestDaemonVersion } from "@/lib/daemon-download";
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";
import { isSafeInternalPath } from "@/lib/auth";

/**
 * OS-specific command to start an ALREADY-installed daemon — the fallback when
 * the devaccel:// protocol prompt doesn't work (and the only path on macOS,
 * where a bare binary can't register a URL scheme). `install` is idempotent:
 * it starts the daemon detached/hidden and repairs login auto-start.
 */
function startCommand(os: "win" | "mac" | "linux"): string {
  if (os === "win") return `& "$env:USERPROFILE\\.devaccel\\devaccel.exe" install`;
  return `~/.devaccel/devaccel install`;
}

/** True when `latest` is a strictly newer dotted version than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function CopyRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5">
      <p className="text-[10px] text-slate-500 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-[11px] font-mono text-slate-300">
          {command}
        </code>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          }}
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded border border-slate-600 hover:border-violet-500 text-[11px] text-slate-300 hover:text-violet-300 transition-colors shrink-0"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Where the user is in the one-time flow: Install → Connect → Open Workspaces.
 * Shown at the top of this page because it's the gate every user hits first —
 * without it, "Daemon not connected" reads like an error instead of step 1 of 3.
 */
function SetupProgress({ connected, installed }: { connected: boolean; installed: boolean }) {
  const steps = [
    { label: "Install daemon", Icon: Download, done: installed || connected },
    { label: "Connect", Icon: ShieldCheck, done: connected },
    { label: "Open Workspaces", Icon: FolderGit2, done: false },
  ];
  // The first not-yet-done step is the one to act on.
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <ol className="flex items-center gap-1.5" aria-label="Setup progress">
      {steps.map((step, i) => {
        const active = i === activeIndex;
        const { Icon } = step;
        return (
          <React.Fragment key={step.label}>
            <li
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                step.done
                  ? "border-emerald-800/60 bg-emerald-950/20 text-emerald-300"
                  : active
                    ? "border-violet-700/60 bg-violet-950/20 text-violet-200"
                    : "border-slate-800 bg-slate-900/40 text-slate-600"
              }`}
            >
              {step.done ? (
                <Check className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate text-[11px] font-medium">{step.label}</span>
            </li>
            {i < steps.length - 1 && (
              <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-slate-700" />
            )}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

function SetupDaemonPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sign-in sends users here with ?next=… so local file access is established
  // before they reach a workspace route. Sidebar navigation carries no `next`,
  // so this page never auto-advances when you came to MANAGE the daemon.
  const nextParam = searchParams.get("next");
  const handOffTo = isSafeInternalPath(nextParam) ? (nextParam as string) : null;

  const { connected, version, checking, installed, refresh } = useDaemonStatus();

  useEffect(() => {
    if (handOffTo && connected) router.replace(handOffTo);
  }, [handOffTo, connected, router]);
  const [os, setOs] = useState<"win" | "mac" | "linux">("win");
  useEffect(() => { setOs(detectOS()); }, []);

  const [busy, setBusy] = useState<null | "stop" | "uninstall" | "update">(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  // Start panel: one-click start via the devaccel:// protocol; reveal the
  // copy-paste fallback if the daemon hasn't connected shortly after.
  const [startFired, setStartFired] = useState(false);
  const [showStartFallback, setShowStartFallback] = useState(false);
  // "Not installed anymore? Reinstall" escape hatch from the Start panel.
  const [forceInstallPanel, setForceInstallPanel] = useState(false);

  // Update: newest published version (null = unknown/unavailable → no button).
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!canAccessWorkspaceStudio()) router.replace("/");
  }, [router]);

  // Check for a newer published build whenever we (re)connect.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void getLatestDaemonVersion().then((v) => { if (!cancelled) setLatestVersion(v); });
    return () => { cancelled = true; };
  }, [connected, version]);

  // Once connected, reset the Start-panel state for the next time.
  useEffect(() => {
    if (connected) {
      setStartFired(false);
      setShowStartFallback(false);
      setForceInstallPanel(false);
    }
  }, [connected]);

  // After firing devaccel://start, give the daemon ~10s to come up before
  // offering the copy-paste fallback (the 4s status poll does the detection).
  useEffect(() => {
    if (!startFired || connected) return;
    const t = window.setTimeout(() => setShowStartFallback(true), 10_000);
    return () => window.clearTimeout(t);
  }, [startFired, connected]);

  const handleStart = () => {
    setErr(""); setNotice("");
    setStartFired(true);
    // Navigating to the custom protocol shows the browser's native
    // "Open DevAccel?" prompt and launches the installed daemon; the page
    // itself doesn't navigate away. If no handler is registered the browser
    // silently ignores it — the fallback command appears after the timeout.
    window.location.href = "devaccel://start";
    void refresh();
  };

  const handleStop = async () => {
    setErr(""); setNotice(""); setBusy("stop");
    try {
      await agentClient.stopDaemon();
      setNotice("Daemon stopped.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const handleUpdate = async () => {
    setErr(""); setNotice(""); setBusy("update");
    try {
      const { url } = await getDaemonDownloadUrl(os);
      await agentClient.updateDaemon(url);
      setNotice("Updating — the daemon downloads the new version, restarts and reconnects automatically.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const handleUninstall = async () => {
    setErr(""); setNotice(""); setBusy("uninstall");
    try {
      await agentClient.uninstallDaemon();
      setNotice("Daemon uninstalled — auto-start removed and files scheduled for deletion.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setConfirmUninstall(false);
      await refresh();
    }
  };

  const updateAvailable = Boolean(connected && version && latestVersion && isNewerVersion(latestVersion, version));
  const showStartPanel = !connected && installed && !forceInstallPanel;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          <Server className="h-5 w-5 text-violet-400" /> Daemon Setup
        </h1>
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">
          The DevAccel daemon runs on <span className="text-slate-400">your machine</span> and lets
          the app read &amp; write your local files securely. All daemon management lives here — the
          Workspaces menu stays disabled until it&apos;s connected.{" "}
          <Link
            href="/workspaces/guide"
            className="inline-flex items-center gap-1 text-violet-400 underline underline-offset-2 hover:text-violet-300"
          >
            <BookOpen className="h-3 w-3" /> Read the setup guide
          </Link>
        </p>
      </div>

      <SetupProgress connected={connected} installed={installed} />

      {/* Status card */}
      <div className={`rounded-xl border p-4 ${connected ? "border-emerald-800/50 bg-emerald-950/20" : "border-slate-800 bg-slate-900/50"}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {checking && !connected ? (
              <Loader2 className="h-5 w-5 text-slate-500 animate-spin" />
            ) : connected ? (
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            ) : (
              <span className="h-3 w-3 rounded-full bg-slate-600 mx-1" />
            )}
            <div>
              <p className={`text-sm font-medium ${connected ? "text-emerald-300" : "text-slate-300"}`}>
                {connected ? "Daemon connected" : checking ? "Checking…" : "Daemon not connected"}
              </p>
              {connected && version && <p className="text-[11px] text-slate-500">version {version}</p>}
              {!connected && !checking && (
                <p className="text-[11px] text-slate-500">
                  Just restarted your computer? The daemon auto-starts at login but can take a minute
                  or two on managed machines — no reinstall needed, this page reconnects automatically.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-slate-700 hover:border-violet-500 text-[11px] text-slate-300 hover:text-violet-300 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} /> Check now
          </button>
        </div>

        {notice && <p className="mt-3 text-[11px] text-emerald-400">{notice}</p>}
        {err && <p className="mt-3 text-[11px] text-red-400">{err}</p>}
      </div>

      {/* Connected: get out of this page and into the product */}
      {connected && (
        <button
          type="button"
          onClick={() => router.push("/workspaces")}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-4 text-[12px] font-medium text-white transition-colors hover:bg-violet-500"
        >
          <FolderGit2 className="h-3.5 w-3.5" /> Open Workspaces
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Connected: management actions */}
      {connected ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-300">Manage</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleStop}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-700 hover:border-amber-500 disabled:opacity-50 text-[12px] text-slate-200 hover:text-amber-300 transition-colors"
            >
              {busy === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              Stop
            </button>

            {updateAvailable && (
              <button
                type="button"
                onClick={handleUpdate}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[12px] font-medium text-white transition-colors"
              >
                {busy === "update" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                Update to v{latestVersion}
              </button>
            )}

            {confirmUninstall ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-red-400">Remove the daemon from this machine?</span>
                <button
                  type="button"
                  onClick={handleUninstall}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 text-[12px] font-medium text-white transition-colors"
                >
                  {busy === "uninstall" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Uninstall
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmUninstall(false)}
                  disabled={busy !== null}
                  className="h-8 px-3 rounded-md border border-slate-700 text-[12px] text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUninstall(true)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-700 hover:border-red-500 disabled:opacity-50 text-[12px] text-slate-200 hover:text-red-300 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" /> Uninstall
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Stop, Update and Uninstall run on your machine via the daemon. Update swaps the binary
            in place — no re-download in the browser. Uninstall removes login auto-start and deletes
            the installed binary + local state (~/.devaccel).
          </p>
        </div>
      ) : showStartPanel ? (
        /* Installed (per this browser's memory) but not running: Start panel */
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
            <Play className="h-3.5 w-3.5" /> Daemon installed but not running
          </p>
          {os !== "mac" ? (
            <>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                No reinstall needed. Click Start — your browser will ask to{" "}
                <span className="text-slate-400">open DevAccel</span>; confirm and the daemon starts.
              </p>
              <button
                type="button"
                onClick={handleStart}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-500 text-[12px] font-medium text-white transition-colors"
              >
                {startFired && checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Start daemon
              </button>
              {startFired && !showStartFallback && (
                <p className="text-[10px] text-slate-500">
                  Waiting for the daemon — this page connects automatically once it&apos;s up.
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] text-slate-500 leading-relaxed">
              No reinstall needed — run this to start the installed daemon:
            </p>
          )}
          {(os === "mac" || showStartFallback) && (
            <div>
              {showStartFallback && os !== "mac" && (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Still not connected? Start it from a terminal instead:
                </p>
              )}
              <CopyRow label={os === "win" ? "PowerShell" : "Terminal"} command={startCommand(os)} />
            </div>
          )}
          <p className="text-[10px] text-slate-500">
            Not installed on this machine anymore?{" "}
            <button
              type="button"
              onClick={() => setForceInstallPanel(true)}
              className="text-violet-400 hover:text-violet-300 underline underline-offset-2"
            >
              Reinstall
            </button>
          </p>
        </div>
      ) : (
        /* Never installed (or user chose Reinstall): Install panel */
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Download className="h-3.5 w-3.5" /> Install
            </p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              One-time step: download and run it once — it installs itself into{" "}
              <span className="text-slate-400">~/.devaccel</span>, starts in the background and
              auto-starts on every future login. After that, Start / Stop / Update / Uninstall are
              one-click from this page. On managed machines double-click may be blocked, so use{" "}
              <span className="text-slate-400">Copy install command</span> and paste it into a terminal.
            </p>
            <DaemonDownloadButton />
          </div>

          <div className="border-t border-slate-800 pt-3">
            <p className="text-xs font-medium text-slate-300">Already installed? Start it</p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              If the daemon is installed on this machine but stopped, run:
            </p>
            <CopyRow label={os === "win" ? "PowerShell" : "Terminal"} command={startCommand(os)} />
            <p className="mt-2 text-[10px] text-slate-500">
              After it starts, this page connects automatically (or click{" "}
              <span className="text-slate-400">Check now</span> above).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SetupDaemonPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-40 items-center justify-center text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      }
    >
      <SetupDaemonPageInner />
    </Suspense>
  );
}
