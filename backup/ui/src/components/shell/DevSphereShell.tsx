"use client";

/**
 * DevSphereShell — the standalone, workspace-centric app chrome.
 *
 * Layout: a collapsible left sidebar (primary navigation) + a slim top bar
 * (page title, live daemon pill, account menu).
 *
 * The sidebar exists because the Workspace routes are a *sequence*, not one
 * page: Setup Guide → Daemon Setup → Workspaces. Without it, `/workspaces/guide`
 * and `/workspaces/setup` were only reachable via the gate redirect in
 * app/workspaces/layout.tsx — a user with a connected daemon had no way back to
 * them, so daemon management (Stop / Update / Uninstall) was unreachable.
 *
 * Immersive routes (login, the full-screen workspace IDE) render bare.
 * ProjectProvider is retained because the workspace/IDE components consume it;
 * there is no user-facing project navigation.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChevronLeft,
  Cpu,
  FolderGit2,
  Gauge,
  Loader2,
  LogOut,
  PanelLeft,
  Server,
  ShieldCheck,
  User,
} from "lucide-react";
import { getUser, getToken, clearToken, logout, type AuthUser } from "@/lib/auth";
import { useDaemonStatus, type DaemonStatus } from "@/lib/hooks/useDaemonStatus";
import { ProjectProvider } from "@/providers/ProjectProvider";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const SIDEBAR_STORAGE_KEY = "devsphere:sidebar-collapsed";

type NavItem = {
  href: string;
  label: string;
  /** One-line explanation, shown under the label and as the collapsed tooltip. */
  hint: string;
  Icon: React.ElementType;
  /** Paths that must NOT mark this item active (sub-routes owned by siblings). */
  excludes?: string[];
  /** Disabled until the daemon is connected. */
  requiresDaemon?: boolean;
};

const WORKSPACE_NAV: NavItem[] = [
  {
    href: "/workspaces/guide",
    label: "Setup Guide",
    hint: "How the local-file flow works",
    Icon: BookOpen,
  },
  {
    href: "/workspaces/setup",
    label: "Daemon Setup",
    hint: "Install, start, update or remove the daemon",
    Icon: Server,
  },
  {
    href: "/workspaces",
    label: "Workspaces",
    hint: "Open a folder and start building",
    Icon: FolderGit2,
    excludes: ["/workspaces/guide", "/workspaces/setup"],
    requiresDaemon: true,
  },
];

const ACCOUNT_NAV: NavItem[] = [
  { href: "/usage", label: "Token Usage", hint: "Your model spend and budget", Icon: Gauge },
  { href: "/profile", label: "My Profile", hint: "Account and session", Icon: User },
];

// Hidden from non-admins as a convenience, not as a control: every
// /api/admin/* route re-checks the role server-side (router/auth.py
// get_current_admin), because hiding a link has never stopped a URL.
const ADMIN_NAV: NavItem[] = [
  {
    href: "/admin/models",
    label: "Models & Budgets",
    hint: "Model catalogue, teams, token limits",
    Icon: Cpu,
  },
];

const ALL_NAV = [...WORKSPACE_NAV, ...ACCOUNT_NAV, ...ADMIN_NAV];

function isActive(pathname: string, item: NavItem): boolean {
  const excluded = (item.excludes ?? []).some(
    (e) => pathname === e || pathname.startsWith(e + "/"),
  );
  if (excluded) return false;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/* ────────────────────────────────────────────────────────────────────────── */

function DaemonPill({ status }: { status: DaemonStatus }) {
  const { connected, version, checking } = status;
  const label = connected
    ? `Daemon connected${version ? ` · v${version}` : ""}`
    : checking
      ? "Checking daemon…"
      : "Daemon not connected";

  return (
    <Link
      href="/workspaces/setup"
      title={connected ? label : "Open Daemon Setup to install or start the daemon"}
      className={cn(
        "inline-flex items-center gap-2 h-7 rounded-full border px-3 text-[11px] font-medium transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
        connected
          ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-300 hover:border-emerald-600"
          : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200",
      )}
    >
      {checking && !connected ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : connected ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
      ) : (
        <span className="h-2 w-2 rounded-full bg-slate-600" />
      )}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}

function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  const handleLogout = () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setShowLogoutConfirm(false);
    setOpen(false);

    if (isIntegrated) {
      // Integrated mode: sign out DevSphere, notify DevAccel, close this tab
      const token = getToken();
      if (token) {
        fetch(`${process.env.NEXT_PUBLIC_DEVSPHERE_API_URL}/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      clearToken();

      // Tell the DevAccel opener tab to sign out too
      if (window.opener) {
        try {
          window.opener.postMessage({ type: "devsphere:logout" }, "*");
        } catch { /* opener may be closed */ }
      }

      // Close this tab (works because DevAccel opened it); fallback to /login
      try {
        window.close();
      } catch { /* ignore */ }
      // If window.close() was blocked by the browser, redirect as fallback
      setTimeout(() => { window.location.href = "/login"; }, 300);
      return;
    }

    startTransition(() => {
      logout();
    });
  };

  const isIntegrated = user.launch_mode === "integrated";
  const initials = (user.username ?? "?").slice(0, 2).toUpperCase();

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white ring-2 ring-slate-800 transition-all hover:ring-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          title={user.username}
        >
          {initials}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-10 z-50 min-w-[200px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl shadow-black/50"
          >
            <div className="border-b border-slate-800 px-4 py-2.5">
              <p className="truncate text-xs font-semibold text-slate-100">{user.username}</p>
              <p className="truncate text-xs text-slate-500">
                {isIntegrated
                  ? <span className="text-indigo-400">DevAccel user</span>
                  : user.is_admin ? <span className="text-amber-400">Administrator</span> : "Member"}
              </p>
            </div>
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
            >
              <User className="h-3.5 w-3.5 text-indigo-400" />
              My Profile
            </Link>
            <button
              onClick={() => { setOpen(false); setShowLogoutConfirm(true); }}
              role="menuitem"
              disabled={loggingOut}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-red-400 disabled:opacity-50"
            >
              {loggingOut ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5 text-red-400" />
              )}
              Sign Out
            </button>
          </div>
        )}
      </div>

      {/* Sign-out confirmation dialog — rendered outside the relative container for correct centering */}
      <Dialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign Out</DialogTitle>
            <DialogDescription>
              {isIntegrated
                ? "This will sign you out from both DevSphere and DevAccel. You will need to log in again to continue."
                : "Are you sure you want to sign out?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setShowLogoutConfirm(false)}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {loggingOut ? "Signing out…" : "Sign Out"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
  daemonConnected,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  daemonConnected: boolean;
}) {
  const active = isActive(pathname, item);
  const disabled = Boolean(item.requiresDaemon && !daemonConnected);
  const { Icon } = item;

  const title = disabled
    ? "Install & connect the daemon (Daemon Setup) to enable Workspaces"
    : collapsed
      ? `${item.label} — ${item.hint}`
      : undefined;

  const body = (
    <>
      {/* Active indicator rail */}
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-all",
          active ? "bg-indigo-400 opacity-100" : "opacity-0",
        )}
      />
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-indigo-300" : "text-slate-500 group-hover:text-slate-300",
        )}
      />
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight">{item.label}</span>
          <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-slate-600 group-hover:text-slate-500">
            {disabled ? "Needs the daemon" : item.hint}
          </span>
        </span>
      )}
      {/* Live daemon dot on the Daemon Setup row */}
      {item.href === "/workspaces/setup" && (
        <span
          aria-hidden
          title={daemonConnected ? "Daemon connected" : "Daemon not connected"}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            daemonConnected ? "bg-emerald-400" : "bg-slate-600",
          )}
        />
      )}
    </>
  );

  const className = cn(
    "group relative flex items-center gap-2.5 rounded-lg py-2 transition-colors",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
    collapsed ? "justify-center px-0" : "pl-3 pr-2.5",
    active
      ? "bg-indigo-500/10 text-indigo-200"
      : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100",
    disabled && "pointer-events-none opacity-40",
  );

  if (disabled) {
    return (
      <li>
        <span className={className} title={title} aria-disabled>
          {body}
        </span>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={item.href}
        title={title}
        aria-current={active ? "page" : undefined}
        className={className}
      >
        {body}
      </Link>
    </li>
  );
}

function Sidebar({
  pathname,
  collapsed,
  onToggle,
  daemonConnected,
  isAdmin,
}: {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  daemonConnected: boolean;
  isAdmin: boolean;
}) {
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-slate-800 bg-slate-950/80 transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-64",
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-slate-800",
          collapsed ? "justify-center px-0" : "px-4",
        )}
      >
        <Link
          href="/workspaces"
          className="group flex items-center gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 rounded-lg"
        >
          {/* CGI logo — matches DevAccel branding */}
          <img src="/cgi-logo.png" alt="CGI" className="h-8 w-auto object-contain" />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block text-sm font-bold leading-none text-slate-100">
                DevSphere AI
              </span>
              <span className="mt-1 block text-[10.5px] leading-none text-slate-500">
                Local-first coding agent
              </span>
            </span>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-2.5 py-4">
        <div>
          {!collapsed && (
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              Workspace
            </p>
          )}
          <ul className="space-y-0.5">
            {WORKSPACE_NAV.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                collapsed={collapsed}
                daemonConnected={daemonConnected}
              />
            ))}
          </ul>
        </div>

        <div>
          {!collapsed && (
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              Account
            </p>
          )}
          <ul className="space-y-0.5">
            {ACCOUNT_NAV.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                collapsed={collapsed}
                daemonConnected={daemonConnected}
              />
            ))}
          </ul>
        </div>

        {isAdmin && (
          <div className="mt-4">
            {!collapsed && (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Administration
              </p>
            )}
            <ul className="space-y-0.5">
              {ADMIN_NAV.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  collapsed={collapsed}
                  daemonConnected={daemonConnected}
                />
              ))}
            </ul>
          </div>
        )}
      </nav>

      {/* Daemon summary + collapse toggle */}
      <div className="shrink-0 border-t border-slate-800 p-2.5">
        {!collapsed && (
          <div
            className={cn(
              "mb-2 rounded-lg border p-2.5",
              daemonConnected
                ? "border-emerald-900/60 bg-emerald-950/20"
                : "border-slate-800 bg-slate-900/50",
            )}
          >
            <p
              className={cn(
                "flex items-center gap-1.5 text-[11px] font-medium",
                daemonConnected ? "text-emerald-300" : "text-slate-400",
              )}
            >
              {daemonConnected ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <Server className="h-3.5 w-3.5" />
              )}
              {daemonConnected ? "Local access on" : "Local access off"}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              {daemonConnected
                ? "Your files stay on your machine — the daemon reads and writes them locally."
                : "Install the daemon to let DevSphere work with files on your machine."}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[11px] text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

export function DevSphereShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  // Signed-out auth routes render their own full-page layout — no app chrome.
  const isAuthPage =
    pathname === "/login" || pathname === "/register" || pathname === "/forgot-username" || pathname === "/integrate";
  // The workspace IDE takes over the full screen.
  const isWorkspaceIde = /^\/workspaces\/[^/]+\/ide$/.test(pathname);
  const immersive = isAuthPage || isWorkspaceIde;

  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // localStorage and the JWT are browser-only: read after mount so the server
  // render and the first client render agree (no hydration mismatch).
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1");
    setMounted(true);
  }, []);

  // Re-read user whenever the route changes (e.g. after login navigates away
  // from /login, the token is now present in localStorage).
  useEffect(() => {
    setUser(getUser());
  }, [pathname]);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // One daemon poll for the whole chrome. Skipped on immersive routes (login
  // has no daemon concept; the IDE runs its own connection handling).
  const daemon = useDaemonStatus(immersive ? 0 : 4000);

  if (immersive) {
    return (
      <ProjectProvider>
        {/* Signed-out pages have no chrome, so the switch floats — without it
            login/register were the one part of the app stuck on dark. The IDE
            is excluded: its own TopBar already carries the same toggle. */}
        {isAuthPage && (
          <ThemeToggle className="fixed right-4 top-4 z-50 bg-slate-900/60 backdrop-blur" />
        )}
        {children}
      </ProjectProvider>
    );
  }

  const current = ALL_NAV.find((item) => isActive(pathname, item));

  return (
    <ProjectProvider>
      <div className="flex h-screen overflow-hidden bg-slate-950">
        {mounted && user && (
          <Sidebar
            pathname={pathname}
            collapsed={collapsed}
            onToggle={toggleSidebar}
            daemonConnected={daemon.connected}
            isAdmin={user.is_admin || user.role === "admin"}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-800 bg-slate-950/80 px-5 backdrop-blur">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-slate-100">
                {current?.label ?? "DevSphere AI"}
              </h1>
              {current?.hint && (
                <p className="truncate text-[11px] leading-none text-slate-500">{current.hint}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <DaemonPill status={daemon} />
              {/* One switch for the whole product — see lib/theme.ts. */}
              <ThemeToggle />
              {mounted && user && <UserMenu user={user} />}
            </div>
          </header>

          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
          </main>
        </div>
      </div>
    </ProjectProvider>
  );
}
