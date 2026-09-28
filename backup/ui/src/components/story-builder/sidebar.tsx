"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useActiveCodeBuilderRuns } from "@/hooks/useActiveCodeBuilderRuns";
import {
  BookOpen,
  Sparkles,
  LayoutDashboard,
  Activity,
  Users,
  ShieldCheck,
  Home,
  FolderKanban,
  FolderGit2,
  Database,
  Layers,
  ChevronDown,
  ChevronRight,
  Bot,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getUser, type AuthUser } from "@/lib/auth";
import { WORKSPACE_STUDIO_ROLE } from "@/lib/workspace-rbac";
import { useDaemonStatus } from "@/lib/hooks/useDaemonStatus";

/* ─── helpers ──────────────────────────────────────────────────── */

/** Returns true when the current pathname belongs to any of the given prefixes. */
function pathMatchesAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/* ─── component ─────────────────────────────────────────────────── */

export function Sidebar({ className }: { className?: string } = {}) {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, [pathname]);

  const canGenerate   = user?.is_admin || (user?.roles ?? []).includes("generate_user_story");
  const canView       = user?.is_admin || (user?.roles ?? []).includes("view_user_story");
  const canCreate     = user?.is_admin || (user?.roles ?? []).includes("create_project");
  const canEdit       = user?.is_admin || (user?.roles ?? []).includes("edit_project");
  const canIngest     = user?.is_admin || (user?.roles ?? []).includes("context_creation");
  const canViewCode   = user?.is_admin || (user?.roles ?? []).includes("view_code");
  const DOC_ROLES     = ["view_documents", "generate_hld_documents", "generate_lld_documents", "generate_req_documents"];
  const canViewDocs        = user?.is_admin || (user?.roles ?? []).some((r) => DOC_ROLES.includes(r));
  const canConfigureModels  = user?.is_admin || (user?.roles ?? []).includes("configure_models");
  const isAdmin             = user?.is_admin ?? false;
  const canVectorDb         = isAdmin || (user?.roles ?? []).includes("db_monitor_user");
  const canWorkspaceStudio  = isAdmin || (user?.roles ?? []).includes(WORKSPACE_STUDIO_ROLE);
  const showGenerate        = canGenerate || canView;
  const showGenerateSection = showGenerate || canViewDocs || canViewCode;

  // Live daemon status — gates the Workspaces submenu item (disabled until the
  // local daemon is installed & connected). Longer poll: the sidebar is on
  // every page, and quickDetect is a single cheap 127.0.0.1 probe.
  const { connected: daemonConnected } = useDaemonStatus(8000);

  /* Collapsible section open-state — default open when current path is inside */
  const [openWorkspace,    setOpenWorkspace]    = useState(() => pathMatchesAny(pathname, ["/workspaces"]));
  const [openIngest,       setOpenIngest]       = useState(() => pathMatchesAny(pathname, ["/ingest", "/standards"]));
  const [openGenerate,     setOpenGenerate]     = useState(() => pathMatchesAny(pathname, ["/generate", "/jobs", "/code-builder", "/document-builder"]));
  const [openAdmin,        setOpenAdmin]        = useState(() => pathMatchesAny(pathname, ["/admin", "/health", "/db-monitor", "/db-monitor/vector-explorer"]));  // /admin covers /admin/models too
  const [openUserStory,    setOpenUserStory]    = useState(true);
  const [openCodeBuilder,  setOpenCodeBuilder]  = useState(true);
  const [openLegacyModernization, setOpenLegacyModernization] = useState(true);
  const [openDocBuilder,   setOpenDocBuilder]   = useState(true);

  // Live count of running Code Builder pipelines — surfaces a small badge
  // on the Code Studio link so users see in-progress runs from anywhere.
  const { runningCount: cbRunningCount } = useActiveCodeBuilderRuns();

  /* Auto-expand if navigation lands inside a collapsed section */
  useEffect(() => {
    if (pathMatchesAny(pathname, ["/workspaces"]))                                              setOpenWorkspace(true);
    if (pathMatchesAny(pathname, ["/ingest", "/standards"]))                                    setOpenIngest(true);
    if (pathMatchesAny(pathname, ["/generate", "/jobs", "/code-builder", "/legacy-modernization", "/document-builder"])) setOpenGenerate(true);
    if (pathMatchesAny(pathname, ["/admin", "/health", "/db-monitor", "/db-monitor/vector-explorer"]))  setOpenAdmin(true);
    if (pathMatchesAny(pathname, ["/generate", "/jobs"]))                                       setOpenUserStory(true);
    if (pathMatchesAny(pathname, ["/code-builder"]))                                           setOpenCodeBuilder(true);
    if (pathMatchesAny(pathname, ["/legacy-modernization"]))                                   setOpenLegacyModernization(true);
    if (pathMatchesAny(pathname, ["/document-builder"]))                                        setOpenDocBuilder(true);
  }, [pathname]);

  /* ── sub-components ── */

  function NavLink({
    href, label, Icon, excludes = [], disabled = false, title, trailing,
  }: {
    href: string;
    label: string;
    Icon: React.ElementType;
    /** Child routes that should NOT mark this link active (sibling submenu items). */
    excludes?: string[];
    /** Render non-clickable (e.g. Workspaces until the daemon is connected). */
    disabled?: boolean;
    title?: string;
    /** Optional right-side adornment (e.g. daemon status dot). */
    trailing?: React.ReactNode;
  }) {
    const active =
      (pathname === href || (href !== "/ingest" && pathname.startsWith(href + "/"))) &&
      !excludes.some((e) => pathname === e || pathname.startsWith(e + "/"));
    if (disabled) {
      return (
        <li>
          <span
            title={title}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-600 cursor-not-allowed opacity-60"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {trailing}
          </span>
        </li>
      );
    }
    return (
      <li>
        <Link
          href={href}
          title={title}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
            active
              ? "bg-indigo-600/15 text-indigo-400 font-medium"
              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1">{label}</span>
          {trailing}
        </Link>
      </li>
    );
  }

  /** Clickable section header that collapses / expands its children */
  function SectionHeader({
    label, icon: Icon, open, onToggle, hasActive,
  }: {
    label: string;
    icon?: React.ElementType;
    open: boolean;
    onToggle: () => void;
    hasActive?: boolean;
  }) {
    return (
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors",
          hasActive ? "text-indigo-400" : "text-slate-500 hover:text-slate-300"
        )}
      >
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="flex-1 text-left">{label}</span>
        {open
          ? <ChevronDown  className="h-3 w-3 shrink-0 transition-transform" />
          : <ChevronRight className="h-3 w-3 shrink-0 transition-transform" />}
      </button>
    );
  }

  /** Sub-group divider inside Generate — collapsible */
  function SubGroupHeader({
    label, open, onToggle,
  }: {
    label: string;
    open: boolean;
    onToggle: () => void;
  }) {
    return (
      <li className="pt-2 pb-0.5">
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-1 pl-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors rounded-md py-0.5"
        >
          {open
            ? <ChevronDown  className="h-3 w-3 shrink-0 transition-transform" />
            : <ChevronRight className="h-3 w-3 shrink-0 transition-transform" />}
          <span className="flex-1 text-left">{label}</span>
        </button>
      </li>
    );
  }

  /** Indented child link inside a sub-group */
  function SubNavLink({
    href,
    label,
    Icon,
    excludes = [],
    badge,
  }: {
    href: string;
    label: string;
    Icon: React.ElementType;
    excludes?: string[];
    badge?: number;
  }) {
    const active = (pathname === href || pathname.startsWith(href + "/")) && !excludes.some((e) => pathname === e || pathname.startsWith(e + "/"));
    return (
      <li>
        <Link
          href={href}
          className={cn(
            "flex items-center gap-2 rounded-lg pl-6 pr-2.5 py-1.5 text-sm transition-colors",
            active
              ? "bg-indigo-600/15 text-indigo-400 font-medium"
              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{label}</span>
          {badge != null && badge > 0 && (
            <span
              title={`${badge} running pipeline${badge > 1 ? "s" : ""}`}
              className="ml-auto flex items-center gap-1 rounded-full bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 text-[10px] font-medium"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
              {badge}
            </span>
          )}
        </Link>
      </li>
    );
  }

  /* ── render ── */

  return (
    <aside className={className ?? "flex h-full w-60 flex-col border-r border-slate-800 bg-slate-950"}>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">

        {/* Home — single item, never collapsed */}
        <ul className="space-y-0.5">
          <NavLink href="/" label="Home" Icon={Home} />
        </ul>

        {/* Workspace — collapsible (guide / daemon / workspaces). The Workspaces
            item stays disabled until the local daemon is connected; daemon
            management lives exclusively under Daemon Setup. */}
        {canWorkspaceStudio && (
          <div className="space-y-0.5">
            <SectionHeader
              label="Workspace"
              open={openWorkspace}
              onToggle={() => setOpenWorkspace((o) => !o)}
              hasActive={pathMatchesAny(pathname, ["/workspaces"])}
            />
            {openWorkspace && (
              <ul className="space-y-0.5 mt-0.5">
                <NavLink href="/workspaces/guide" label="Setup Guide" Icon={BookOpen} />
                <NavLink
                  href="/workspaces/setup"
                  label="Daemon Setup"
                  Icon={Server}
                  trailing={
                    <span
                      title={daemonConnected ? "Daemon connected" : "Daemon not connected"}
                      className={cn("h-2 w-2 rounded-full shrink-0", daemonConnected ? "bg-emerald-400" : "bg-slate-600")}
                    />
                  }
                />
                <NavLink
                  href="/workspaces"
                  label="Workspaces"
                  Icon={FolderGit2}
                  excludes={["/workspaces/guide", "/workspaces/setup"]}
                  disabled={!daemonConnected}
                  title={daemonConnected ? undefined : "Install & connect the daemon (Daemon Setup) to enable Workspaces"}
                />
              </ul>
            )}
          </div>
        )}

        {/* Projects — single item, never collapsed */}
        {(canCreate || canEdit) && (
          <ul className="space-y-0.5">
            <NavLink href="/projects" label="All Projects" Icon={FolderKanban} />
          </ul>
        )}

        {/* Ingest — collapsible (2 items) */}
        {canIngest && (
          <div className="space-y-0.5">
            <SectionHeader
              label="Ingest"
              open={openIngest}
              onToggle={() => setOpenIngest((o) => !o)}
              hasActive={pathMatchesAny(pathname, ["/ingest", "/standards"])}
            />
            {openIngest && (
              <ul className="space-y-0.5 mt-0.5">
                <NavLink href="/ingest"    label="All Context" Icon={Layers}   />
                <NavLink href="/standards" label="Standards"   Icon={BookOpen} />
              </ul>
            )}
          </div>
        )}

        {/* Generate — collapsible (3 sub-groups × multiple items) */}
        {showGenerateSection && (
        <div className="space-y-0.5">
          <SectionHeader
            label="Generate"
            open={openGenerate}
            onToggle={() => setOpenGenerate((o) => !o)}
            hasActive={pathMatchesAny(pathname, ["/generate", "/jobs", "/code-builder", "/legacy-modernization", "/document-builder"])}
          />
          {openGenerate && (
            <ul className="space-y-0.5 mt-0.5">

              {/* User Story Builder */}
              {showGenerate && (
                <>
                  <SubGroupHeader
                    label="User Story Builder"
                    open={openUserStory}
                    onToggle={() => setOpenUserStory((o) => !o)}
                  />
                  {openUserStory && (
                    <>
                      {canGenerate && (
                        <SubNavLink href="/generate" label="Story Generator" Icon={Sparkles} />
                      )}
                      {canView && (
                        <SubNavLink href="/jobs" label="Jobs Dashboard" Icon={LayoutDashboard} />
                      )}
                    </>
                  )}
                </>
              )}

              {/* Document Builder */}
              {canViewDocs && (
                <>
                  <SubGroupHeader
                    label="Document Builder"
                    open={openDocBuilder}
                    onToggle={() => setOpenDocBuilder((o) => !o)}
                  />
                  {openDocBuilder && (
                    <>
                      <SubNavLink href="/document-builder" label="Document Generator" Icon={LayoutDashboard} excludes={["/document-builder/jobs"]} />
                      <SubNavLink href="/document-builder/jobs" label="Jobs Dashboard" Icon={Layers} />
                    </>
                  )}
                </>
              )}

              {/* Code Builder */}
              {canViewCode && (
                <>
                  <SubGroupHeader
                    label="Code Builder"
                    open={openCodeBuilder}
                    onToggle={() => setOpenCodeBuilder((o) => !o)}
                  />
                  {openCodeBuilder && (
                    <>
                      <SubNavLink href="/code-builder" label="Code Studio" Icon={LayoutDashboard} badge={cbRunningCount} />
                    </>
                  )}
                </>
              )}

              {canViewCode && (
                <>
                  <SubGroupHeader
                    label="Legacy Modernization"
                    open={openLegacyModernization}
                    onToggle={() => setOpenLegacyModernization((o) => !o)}
                  />
                  {openLegacyModernization && (
                    <>
                      <SubNavLink href="/legacy-modernization" label="Modernization Studio" Icon={LayoutDashboard} />
                    </>
                  )}
                </>
              )}
              
            </ul>
          )}
        </div>
        )}

        {/* Admin — collapsible, visible to admins and users with configure_models */}
        {(isAdmin || canConfigureModels) && (
          <div className="space-y-0.5">
            <SectionHeader
              label="Admin"
              icon={ShieldCheck}
              open={openAdmin}
              onToggle={() => setOpenAdmin((o) => !o)}
              hasActive={pathMatchesAny(pathname, ["/admin", "/health", "/db-monitor"])}
            />
            {openAdmin && (
              <ul className="space-y-0.5 mt-0.5">
                {isAdmin && <NavLink href="/admin/users"  label="Users & Roles" Icon={Users}       />}
                {isAdmin && <NavLink href="/admin/groups" label="Teams"         Icon={ShieldCheck} />}
                {canConfigureModels && <NavLink href="/admin/models" label="Model Configs" Icon={Bot} />}
                {isAdmin && <NavLink href="/health"       label="API Health"    Icon={Activity}    />}
                {isAdmin && <NavLink href="/db-monitor"              label="DB Monitor"         Icon={Database}    />}
              </ul>
            )}
          </div>
        )}

      </nav>
    </aside>
  );
}
