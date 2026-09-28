"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, LogOut, User } from "lucide-react";
import { Sidebar } from "@/components/story-builder/sidebar";
import { getUser, logout, type AuthUser } from "@/lib/auth";
import { ProjectProvider } from "@/providers/ProjectProvider";
import { GlobalProjectDropdown } from "@/components/story-builder/GlobalProjectDropdown";

function UserMenu() {
  const [open, setOpen]         = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [, startTransition]     = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUser(getUser());
    setMounted(true);
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleLogout = () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setOpen(false);
    startTransition(() => { logout(); });
  };

  if (!mounted) return null;
  if (!user) return null;

  const initials = (user.username ?? "?").slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      {/* Avatar button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white hover:bg-indigo-500 transition-colors ring-2 ring-slate-800 hover:ring-indigo-500"
        title={user.username}
      >
        {initials}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-10 z-50 min-w-[180px] rounded-xl border border-slate-700 bg-slate-900 shadow-xl py-1">
          {/* User info */}
          <div className="px-4 py-2.5 border-b border-slate-800">
            <p className="text-xs font-semibold text-slate-100 truncate">{user.username}</p>
            <p className="text-xs text-slate-500 truncate">
              {user.is_admin ? <span className="text-amber-400">Administrator</span> : `${user.roles.length} role${user.roles.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          {/* Options */}
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          >
            <User className="h-3.5 w-3.5 text-indigo-400" />
            My Profile
          </Link>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            {loggingOut
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <LogOut className="h-3.5 w-3.5 text-red-400" />}
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

/** Wraps the app — shows sidebar + top header on all routes except immersive workspaces */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const isCodeBuilder = pathname === "/code-builder" || pathname === "/legacy-modernization";
  const isDocumentFullView = /^\/document-builder\/[^/]+\/full-view$/.test(pathname);
  // Immersive Workspace IDE: /workspaces/<id>/ide takes over the full screen.
  const isWorkspaceIde = /^\/workspaces\/[^/]+\/ide$/.test(pathname);

  if (isLoginPage || isCodeBuilder || isDocumentFullView || isWorkspaceIde) {
    return <>{children}</>;
  }

  return (
    <ProjectProvider>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Top header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-5">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cgi-logo.png" alt="CGI" height={28} className="object-contain h-7 w-auto" />
            <div>
              <p className="text-sm font-bold text-slate-100 leading-none">DevAccel</p>
              <p className="text-xs text-slate-500 mt-0.5 leading-none">AI Dev Accelerator</p>
            </div>
          </Link>
          {/* Right: project dropdown + profile menu */}
          <div className="flex items-center gap-3">
            <GlobalProjectDropdown />
            <div className="w-px h-6 bg-slate-800 shrink-0" />
            <UserMenu />
          </div>
        </header>

        {/* Below header: sidebar + content */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-8 py-8">{children}</div>
          </main>
        </div>
      </div>
    </ProjectProvider>
  );
}
