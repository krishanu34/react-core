"use client";

/**
 * ActivityBar — floating glass-island icon rail. Switches the primary side-bar
 * view. Differentiated from VS Code with floating capsule groups, glow
 * indicators, and custom slide-in tooltips.
 */
import { useEffect, useRef, useState } from "react";
import {
  Files,
  Search,
  GitBranch,
  Puzzle,
  Settings,
  UserCircle2,
  PanelLeft,
  PlugZap,
  Plug,
  Layers,
  DatabaseZap,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

export type ActivityView =
  | "projects"
  | "explorer"
  | "search"
  | "appnav"
  | "allcontext"
  | "scm"
  | "source"
  | "mcp"
  | "extensions"
  | "runs"
  | "settings";

const VISIBLE_ITEMS: { id: ActivityView; label: string; icon: LucideIcon }[] = [
  { id: "explorer",    label: "Explorer",                icon: Files },
  { id: "search",      label: "Search",                  icon: Search },
  { id: "appnav",      label: "App Navigation",          icon: PanelLeft },
  { id: "source",      label: "Workspace Connector",     icon: PlugZap },
  { id: "mcp",         label: "MCP Servers",             icon: Plug },
  { id: "projects",    label: "Project Artifacts",       icon: Layers },
  { id: "allcontext",  label: "All Context",             icon: DatabaseZap },
  { id: "scm",         label: "Source Control",           icon: GitBranch },
];

const MORE_ITEMS: { id: ActivityView; label: string; icon: LucideIcon }[] = [
  { id: "extensions",  label: "Extensions / Connectors",  icon: Puzzle },
];

function IslandButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`relative flex items-center justify-center h-9 w-9 rounded-xl transition-all duration-200 ${
          isActive
            ? "bg-gradient-to-br from-violet-500/30 to-indigo-500/20 text-[var(--ide-text)] shadow-[0_0_14px_rgba(124,58,237,0.25)]"
            : "text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
        }`}
      >
        <Icon className="h-[18px] w-[18px] relative z-[1]" />
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-gradient-to-b from-violet-400 to-indigo-500" />
        )}
      </button>
      {hovered && (
        <div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 pointer-events-none">
          <div className="ide-tooltip-bubble px-2.5 py-1 rounded-lg bg-[var(--ide-surface-2)] border border-[var(--ide-glass-border)] text-[11px] font-medium text-[var(--ide-text)] whitespace-nowrap shadow-xl backdrop-blur-md">
            {label}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── More menu (overflow items) ──────────────────────────────────────── */
function MoreMenu({
  items,
  active,
  onSelect,
}: {
  items: { id: ActivityView; label: string; icon: LucideIcon }[];
  active: ActivityView;
  onSelect: (v: ActivityView) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const hasActiveOverflow = items.some((i) => i.id === active);

  return (
    <div ref={ref} className="relative">
      <IslandButton
        icon={MoreHorizontal}
        label="More"
        isActive={hasActiveOverflow}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="absolute left-full top-0 ml-3 z-50 w-52 rounded-xl border border-[var(--ide-glass-border)] bg-[var(--ide-surface-2)] shadow-2xl backdrop-blur-xl py-1 ide-tooltip-bubble">
          {items.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => { onSelect(id); setOpen(false); }}
              className={`flex items-center gap-2.5 w-full px-3 py-2 text-xs text-left transition-colors ${
                active === id
                  ? "bg-violet-600/20 text-violet-300"
                  : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== *
 *  ActivityBar — floating glass islands
 * ========================================================================== */
export function ActivityBar({
  active,
  onSelect,
}: {
  active: ActivityView;
  onSelect: (v: ActivityView) => void;
}) {
  return (
    <nav className="relative z-20 flex flex-col items-center justify-between w-[52px] shrink-0 py-2 px-1.5 gap-2">
      {/* Main icon island */}
      <div className="flex flex-col items-center w-full gap-0.5 bg-[var(--ide-glass)] backdrop-blur-xl border border-[var(--ide-glass-border)] rounded-2xl p-1.5 shadow-lg ide-island-glow overflow-visible">
        {VISIBLE_ITEMS.map(({ id, label, icon }) => (
          <IslandButton
            key={id}
            icon={icon}
            label={label}
            isActive={active === id}
            onClick={() => onSelect(id)}
          />
        ))}
        <MoreMenu items={MORE_ITEMS} active={active} onSelect={onSelect} />
      </div>

      {/* Bottom island: settings + account */}
      <div className="flex flex-col items-center w-full gap-0.5 bg-[var(--ide-glass)] backdrop-blur-xl border border-[var(--ide-glass-border)] rounded-2xl p-1.5 shadow-lg ide-island-glow overflow-visible">
        <IslandButton
          icon={Settings}
          label="Settings"
          isActive={active === "settings"}
          onClick={() => onSelect("settings")}
        />
        <IslandButton
          icon={UserCircle2}
          label="Account"
          isActive={false}
          onClick={() => {}}
        />
      </div>
    </nav>
  );
}

export default ActivityBar;
