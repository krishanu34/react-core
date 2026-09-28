"use client";

/**
 * Workspaces layout — the daemon gate.
 *
 * Navigation between Setup Guide / Daemon Setup / Workspaces lives in the app
 * sidebar (components/shell/DevSphereShell.tsx, "Workspace" section), which also
 * renders the live daemon pill — no in-page tabs and no second status bar here.
 * This layout enforces the access rule: every Workspace route EXCEPT the Setup
 * Guide and Daemon Setup is redirected to Daemon Setup until the local daemon
 * is installed & connected. Daemon management lives exclusively on that page.
 *
 * Works on the VM (HTTP) and locally (HTTPS/localhost): the daemon is probed on
 * 127.0.0.1 in both. The IDE route renders full-screen and is gated only on
 * entry, so a transient probe miss mid-session doesn't eject the user (the IDE's
 * own in-chat "Grant access" flow handles reconnection).
 */

import React, { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useDaemonStatus } from "@/lib/hooks/useDaemonStatus";

const SETUP_ROUTE = "/workspaces/setup";
const GUIDE_ROUTE = "/workspaces/guide";

export default function WorkspacesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  // Passive subscription: the shell owns the poll loop, this only reads it.
  const { connected, checking } = useDaemonStatus(0);

  const isIde = pathname.includes("/ide");
  // Routes reachable without a connected daemon.
  const isUngated = pathname === SETUP_ROUTE || pathname === GUIDE_ROUTE;

  // Once admitted into the IDE while connected, don't continuously re-gate it.
  const ideAdmitted = useRef(false);
  useEffect(() => { if (isIde && connected) ideAdmitted.current = true; }, [isIde, connected]);
  useEffect(() => { if (!isIde) ideAdmitted.current = false; }, [isIde]);

  // Gate on the FIRST completed check and every status change thereafter.
  // `checking` starts true and flips false once the initial probe resolves, so
  // this re-runs even when `connected` stays false (a fresh load with the daemon
  // down) — that was the bug that left the Workspace routes reachable.
  useEffect(() => {
    if (checking) return;               // wait for a completed probe
    if (connected || isUngated) return;
    if (isIde && ideAdmitted.current) return; // already inside with a prior good check
    router.replace(SETUP_ROUTE);
  }, [checking, connected, isUngated, isIde, router]);

  // IDE renders full-screen.
  if (isIde) return <>{children}</>;

  return <>{children}</>;
}
