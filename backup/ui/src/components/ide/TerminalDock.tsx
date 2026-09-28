"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { uuid } from "@/lib/uuid";
import {
  Plus,
  ChevronDown,
  MoreHorizontal,
  Trash2,
  Maximize2,
  Minimize2,
  X,
  Terminal as TerminalIcon,
  AlertCircle,
  Bug,
  ScrollText,
  SplitSquareHorizontal,
  Circle,
  Server,
  Settings,
  Play,
  Check,
} from "lucide-react";

/* ========================================================================== *
 *  Types
 * ========================================================================== */
type PanelTab = "TERMINAL" | "OUTPUT" | "PROBLEMS" | "DEBUG CONSOLE";

type LineType = "output" | "command" | "error" | "info" | "success";

interface TermLine {
  id: number;
  type: LineType;
  text: string;
}

interface TermInstance {
  id: string;
  name: string;
  cwd: string;
  lines: TermLine[];
  history: string[];
  historyIdx: number;
}

/* ========================================================================== *
 *  Virtual filesystem (for ls / cd simulation)
 * ========================================================================== */
const VFS: Record<string, string[]> = {
  "~":                           ["workspace", ".bashrc", ".gitconfig"],
  "~/workspace":                 ["src", "public", "package.json", "tsconfig.json", "README.md"],
  "~/workspace/src":             ["app", "components", "lib", "hooks", "providers"],
  "~/workspace/src/app":         ["page.tsx", "layout.tsx", "globals.css", "workspaces"],
  "~/workspace/src/components":  ["ide", "story-builder"],
  "~/workspace/src/lib":         ["db", "design-tokens.ts", "localFs.ts", "workspace-api.ts"],
};

/* ========================================================================== *
 *  Helpers
 * ========================================================================== */
let _lid = 0;
const mkLine = (type: LineType, text: string): TermLine => ({ id: ++_lid, type, text });

function resolvePath(cwd: string, arg: string): string {
  if (!arg || arg === "~") return "~";
  if (arg.startsWith("~")) return arg;
  if (arg === "..") {
    const parts = cwd.split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") || "~" : "~";
  }
  return `${cwd}/${arg}`;
}

function runCmd(
  raw: string,
  inst: TermInstance,
): { lines: TermLine[]; newCwd?: string; doClear?: boolean } {
  if (!raw.trim()) return { lines: [] };
  const [prog, ...argv] = raw.trim().split(/\s+/);
  const p = prog.toLowerCase();

  if (p === "clear") return { lines: [], doClear: true };

  if (p === "echo")
    return { lines: [mkLine("output", argv.join(" "))] };

  if (p === "pwd")
    return { lines: [mkLine("output", inst.cwd)] };

  if (p === "ls") {
    const dir = argv[0] ? resolvePath(inst.cwd, argv[0]) : inst.cwd;
    const entries = VFS[dir];
    if (!entries)
      return { lines: [mkLine("error", `ls: cannot access '${argv[0] ?? "."}': No such file or directory`)] };
    return { lines: [mkLine("output", entries.join("    ") || "(empty)")] };
  }

  if (p === "cd") {
    const target = argv[0] ?? "~";
    const newCwd = resolvePath(inst.cwd, target);
    if (VFS[newCwd] !== undefined) return { lines: [], newCwd };
    return { lines: [mkLine("error", `cd: ${target}: No such file or directory`)] };
  }

  if (p === "whoami")  return { lines: [mkLine("output", "dev-user")] };
  if (p === "date")    return { lines: [mkLine("output", new Date().toLocaleString())] };
  if (p === "uname")   return { lines: [mkLine("output", "Code Studio 1.0 (browser)")] };
  if (p === "history") {
    return {
      lines: inst.history.map((h, i) => mkLine("output", `  ${String(i + 1).padStart(3, " ")}  ${h}`)),
    };
  }

  if (p === "git") {
    if (argv[0] === "status")
      return {
        lines: [
          mkLine("success", "On branch feature/workspace-management-implementation"),
          mkLine("output",  "Changes not staged for commit:"),
          mkLine("output",  "  (use \"git add <file>...\" to update what will be committed)"),
          mkLine("output",  ""),
          mkLine("info",    "        modified:   ui/src/components/ide/TerminalDock.tsx"),
          mkLine("info",    "        modified:   ui/src/components/ide/TopBar.tsx"),
          mkLine("output",  ""),
          mkLine("output",  "no changes added to commit"),
        ],
      };
    if (argv[0] === "log")
      return {
        lines: [
          mkLine("info",   "commit e9d24ec  Code and figma ingest issue fixed"),
          mkLine("info",   "commit e4c2a11  fixed update document flow"),
          mkLine("info",   "commit cf61a19  continuous ping of runs fixed"),
        ],
      };
    if (argv[0] === "branch")
      return { lines: [mkLine("success", "* feature/workspace-management-implementation"), mkLine("output", "  main")] };
    return { lines: [mkLine("info", `[git] Connect backend WebSocket for full git operations.`)] };
  }

  if (["node", "npm", "npx", "yarn", "pnpm", "python", "pip"].includes(p))
    return { lines: [mkLine("info", `[${p}] Connect backend WebSocket for live shell execution.`)] };

  if (p === "help")
    return {
      lines: [
        mkLine("info",   "Code Studio Terminal — built-in commands:"),
        mkLine("output", "  echo <text>    print text"),
        mkLine("output", "  pwd            print working directory"),
        mkLine("output", "  ls [dir]       list directory"),
        mkLine("output", "  cd <dir>       change directory  (cd .., cd ~)"),
        mkLine("output", "  clear          clear screen  (Ctrl+L)"),
        mkLine("output", "  date           current date/time"),
        mkLine("output", "  whoami         current user"),
        mkLine("output", "  history        command history"),
        mkLine("output", "  git status     git status"),
        mkLine("output", "  git log        git log"),
        mkLine("output", "  git branch     list branches"),
        mkLine("output", "  npm / node     wired in live-shell phase"),
      ],
    };

  return { lines: [mkLine("error", `${prog}: command not found — type 'help' for available commands`)] };
}

const INITIAL_TERM_ID = "term-0";

function makeTerm(name: string, id?: string): TermInstance {
  return {
    id: id ?? uuid(),
    name,
    cwd: "~/workspace",
    history: [],
    historyIdx: -1,
    lines: [
      mkLine("info", "Code Studio — Integrated Terminal"),
      mkLine("info", "Type 'help' for available commands. Connect backend for live shell."),
    ],
  };
}

/* ========================================================================== *
 *  Dropdown helpers (used by the new-terminal profile menu)
 * ========================================================================== */
function MenuItem({
  label,
  shortcut,
  icon,
  active,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon?: ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full px-3 py-[5px] text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors text-left"
    >
      <span className="w-3.5 shrink-0 flex items-center justify-center text-emerald-400">
        {active ? <Check className="h-3 w-3" /> : (icon ?? null)}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd className="ml-2 text-[10px] text-[var(--ide-muted)] shrink-0">{shortcut}</kbd>
      )}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-[var(--ide-border)]" />;
}

/* ========================================================================== *
 *  TerminalDock
 * ========================================================================== */
export function TerminalDock({
  onClose,
  onMaximize,
  maximized = false,
}: {
  onClose?: () => void;
  onMaximize?: () => void;
  maximized?: boolean;
}) {
  const [tab,          setTab]          = useState<PanelTab>("TERMINAL");
  const [terminals,      setTerminals]      = useState<TermInstance[]>(() => [makeTerm("bash", INITIAL_TERM_ID)]);
  const [activeId,       setActiveId]       = useState<string>(INITIAL_TERM_ID);
  const [splitId,        setSplitId]        = useState<string | null>(null);
  const [input,          setInput]          = useState("");
  const [showNewTermMenu, setShowNewTermMenu] = useState(false);
  const [showMoreMenu,    setShowMoreMenu]    = useState(false);
  const [defaultProfile,  setDefaultProfile]  = useState("bash");
  const inputRef     = useRef<HTMLInputElement>(null);
  const newTermRef   = useRef<HTMLDivElement>(null);
  const moreMenuRef  = useRef<HTMLDivElement>(null);
  const cmdNavIdxRef = useRef<number>(-1);

  const activeTerm = terminals.find((t) => t.id === activeId) ?? terminals[0];
  const splitTerm  = splitId ? terminals.find((t) => t.id === splitId) : null;

  /* Auto-scroll active terminal */
  useEffect(() => {
    const el = document.getElementById(`tout-${activeId}`);
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTerm?.lines, activeId]);

  /* Focus input when switching to TERMINAL tab */
  useEffect(() => {
    if (tab === "TERMINAL") setTimeout(() => inputRef.current?.focus(), 40);
  }, [tab, activeId]);

  /* ── Mutations ─────────────────────────────────────────────────────────── */
  const mutateTerm = useCallback(
    (id: string, fn: (t: TermInstance) => Partial<TermInstance>) =>
      setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, ...fn(t) } : t))),
    [],
  );

  /* Close dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (newTermRef.current && !newTermRef.current.contains(e.target as Node)) {
        setShowNewTermMenu(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const newTerminal = useCallback(() => {
    const t = makeTerm("bash");
    setTerminals((prev) => [...prev, t]);
    setActiveId(t.id);
  }, []);

  const newTerminalWithProfile = useCallback(
    (profile: string) => {
      setShowNewTermMenu(false);
      const t = makeTerm(profile);
      const greeting: Record<string, string> = {
        "PowerShell":                  "Windows PowerShell — browser simulation mode.",
        "Git Bash":                    "Git Bash — browser simulation mode.",
        "Command Prompt":              "Microsoft Windows Command Prompt — browser simulation mode.",
        "JavaScript Debug Terminal":   "JavaScript Debug Terminal — attach a debugger to use live inspection.",
        "GitHub Copilot CLI":          "GitHub Copilot CLI — connect to the Copilot CLI extension for AI-powered commands.",
      };
      const msg = greeting[profile] ?? `${profile} terminal — browser simulation mode.`;
      t.lines = [mkLine("info", msg)];
      setTerminals((prev) => [...prev, t]);
      setActiveId(t.id);
      if (profile !== "bash") setDefaultProfile(profile);
    },
    [],
  );

  const killTerminal = useCallback(
    (id: string) => {
      if (id === splitId) { setSplitId(null); }
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const fresh = makeTerm("bash");
          setActiveId(fresh.id);
          return [fresh];
        }
        setActiveId((cur) => (cur === id ? next[next.length - 1].id : cur));
        return next;
      });
    },
    [splitId],
  );

  const handleSplit = useCallback(() => {
    if (splitId) {
      killTerminal(splitId);
      setSplitId(null);
    } else {
      const t = makeTerm("bash");
      setTerminals((prev) => [...prev, t]);
      setSplitId(t.id);
    }
  }, [splitId, killTerminal]);

  /* ── More-actions helpers ──────────────────────────────────────────────── */
  const scrollToPrevCommand = useCallback(() => {
    setShowMoreMenu(false);
    const container = document.getElementById(`tout-${activeId}`);
    if (!container) return;
    const cmds = Array.from(container.querySelectorAll<HTMLElement>("[data-cmd]"));
    if (cmds.length === 0) return;
    cmdNavIdxRef.current = cmdNavIdxRef.current <= 0 ? cmds.length - 1 : cmdNavIdxRef.current - 1;
    cmds[cmdNavIdxRef.current]?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const scrollToNextCommand = useCallback(() => {
    setShowMoreMenu(false);
    const container = document.getElementById(`tout-${activeId}`);
    if (!container) return;
    const cmds = Array.from(container.querySelectorAll<HTMLElement>("[data-cmd]"));
    if (cmds.length === 0) return;
    cmdNavIdxRef.current = cmdNavIdxRef.current >= cmds.length - 1 ? 0 : cmdNavIdxRef.current + 1;
    cmds[cmdNavIdxRef.current]?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const clearTerminalAction = useCallback(() => {
    setShowMoreMenu(false);
    if (!activeTerm) return;
    mutateTerm(activeTerm.id, () => ({ lines: [], historyIdx: -1 }));
  }, [activeTerm, mutateTerm]);

  const runActiveFile = useCallback(() => {
    setShowMoreMenu(false);
    if (!activeTerm) return;
    mutateTerm(activeTerm.id, (t) => ({
      lines: [...t.lines, mkLine("info", "[Run Active File] No active file open — open a file in the editor first.")],
    }));
  }, [activeTerm, mutateTerm]);

  const runSelectedText = useCallback(() => {
    setShowMoreMenu(false);
    if (!activeTerm) return;
    const sel = window.getSelection()?.toString().trim();
    if (!sel) {
      mutateTerm(activeTerm.id, (t) => ({
        lines: [...t.lines, mkLine("info", "[Run Selected Text] Select text in the editor, then use this action.")],
      }));
      return;
    }
    const { lines: out, newCwd, doClear } = runCmd(sel, activeTerm);
    const cmdLine = mkLine("command", `${activeTerm.cwd} $ ${sel}`);
    mutateTerm(activeTerm.id, (t) => ({
      lines: doClear ? [] : [...t.lines, cmdLine, ...out],
      cwd: newCwd ?? t.cwd,
      history: [sel, ...t.history].slice(0, 200),
      historyIdx: -1,
    }));
  }, [activeTerm, mutateTerm]);

  const goToRecentDirectory = useCallback(() => {
    setShowMoreMenu(false);
    if (!activeTerm) return;
    const recentCd = activeTerm.history.find((h) => h.trim().startsWith("cd "));
    if (!recentCd) {
      mutateTerm(activeTerm.id, (t) => ({
        lines: [...t.lines, mkLine("info", "[Go to Recent Directory] No recent cd commands in history.")],
      }));
      return;
    }
    setInput(recentCd);
    inputRef.current?.focus();
  }, [activeTerm, mutateTerm]);

  const runRecentCommand = useCallback(() => {
    setShowMoreMenu(false);
    if (!activeTerm) return;
    if (activeTerm.history.length === 0) {
      mutateTerm(activeTerm.id, (t) => ({
        lines: [...t.lines, mkLine("info", "[Run Recent Command] No command history yet.")],
      }));
      return;
    }
    setInput(activeTerm.history[0]);
    inputRef.current?.focus();
  }, [activeTerm, mutateTerm]);

  /* ── Command execution ─────────────────────────────────────────────────── */
  const submit = useCallback(() => {
    if (!activeTerm) return;
    const raw = input;
    const { lines: out, newCwd, doClear } = runCmd(raw, activeTerm);
    const cmdLine = mkLine("command", `${activeTerm.cwd} $ ${raw}`);
    mutateTerm(activeTerm.id, (t) => ({
      lines: doClear ? [] : [...t.lines, cmdLine, ...out],
      cwd:   newCwd ?? t.cwd,
      history:   raw.trim() ? [raw, ...t.history].slice(0, 200) : t.history,
      historyIdx: -1,
    }));
    setInput("");
  }, [activeTerm, input, mutateTerm]);

  const handleKeyDown = useCallback(
    (e: { key: string; ctrlKey: boolean; altKey?: boolean; preventDefault: () => void }) => {
      if (!activeTerm) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = Math.min(activeTerm.historyIdx + 1, activeTerm.history.length - 1);
        setInput(activeTerm.history[idx] ?? "");
        mutateTerm(activeTerm.id, () => ({ historyIdx: idx }));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = Math.max(activeTerm.historyIdx - 1, -1);
        setInput(idx === -1 ? "" : activeTerm.history[idx] ?? "");
        mutateTerm(activeTerm.id, () => ({ historyIdx: idx }));
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        mutateTerm(activeTerm.id, () => ({ lines: [], historyIdx: -1 }));
        setInput("");
      } else if (e.key === "c" && e.ctrlKey) {
        e.preventDefault();
        mutateTerm(activeTerm.id, (t) => ({
          lines: [...t.lines, mkLine("command", `${t.cwd} $ ${input}^C`)],
          historyIdx: -1,
        }));
        setInput("");
      } else if (e.key === "g" && e.ctrlKey && !e.altKey) {
        e.preventDefault();
        goToRecentDirectory();
      } else if (e.key === "r" && e.ctrlKey && e.altKey) {
        e.preventDefault();
        runRecentCommand();
      }
    },
    [activeTerm, submit, mutateTerm, input, goToRecentDirectory, runRecentCommand],
  );

  /* ── Render helpers ────────────────────────────────────────────────────── */
  const lineColor: Record<LineType, string> = {
    output:  "text-[var(--ide-text)]",
    command: "",
    error:   "text-red-400",
    info:    "text-sky-400",
    success: "text-emerald-400",
  };

  const renderLines = (term: TermInstance, isActive: boolean) => (
    <div
      id={`tout-${term.id}`}
      className="flex-1 min-h-0 overflow-auto p-2 font-mono text-[12px] leading-5 cursor-text"
      onClick={() => { setActiveId(term.id); inputRef.current?.focus(); }}
    >
      {term.lines.map((line) =>
        line.type === "command" ? (
          <div key={line.id} data-cmd="true" className="whitespace-pre-wrap break-all">
            <span className="text-emerald-400 text-[11px]">
              {line.text.split(" $ ")[0]}
            </span>
            <span className="text-[var(--ide-muted)]"> $ </span>
            <span className="text-white font-medium">
              {line.text.split(" $ ").slice(1).join(" $ ")}
            </span>
          </div>
        ) : (
          <div key={line.id} className={`whitespace-pre-wrap break-all ${lineColor[line.type]}`}>
            {line.text}
          </div>
        ),
      )}

      {/* Input prompt — only in the active pane */}
      {isActive && (
        <div className="flex items-center mt-0.5 gap-0">
          <span className="text-emerald-400 text-[11px] shrink-0">{term.cwd}</span>
          <span className="text-[var(--ide-muted)] shrink-0"> $ </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 min-w-0 bg-transparent text-[12px] text-white font-mono focus:outline-none caret-white"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Terminal input"
          />
        </div>
      )}
    </div>
  );

  /* ── Tab icons ─────────────────────────────────────────────────────────── */
  const TAB_META: { id: PanelTab; icon: ReactNode; badge?: number }[] = [
    { id: "PROBLEMS",      icon: <AlertCircle className="h-3 w-3" />, badge: 0 },
    { id: "OUTPUT",        icon: <ScrollText  className="h-3 w-3" /> },
    { id: "DEBUG CONSOLE", icon: <Bug         className="h-3 w-3" /> },
    { id: "TERMINAL",      icon: <TerminalIcon className="h-3 w-3" /> },
  ];

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <div className="flex flex-col h-full bg-[var(--ide-surface)] border border-[var(--ide-border)] rounded-md overflow-hidden">

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between h-8 shrink-0 border-b border-[var(--ide-border)]">
        {/* Panel tabs */}
        <div className="flex items-center h-full overflow-x-auto">
          {TAB_META.map(({ id, icon, badge }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`h-full flex items-center gap-1.5 px-3 text-[11px] tracking-wide border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === id
                  ? "text-[var(--ide-text)] border-violet-500"
                  : "text-[var(--ide-muted)] border-transparent hover:text-[var(--ide-text)]"
              }`}
            >
              {icon}
              {id}
              {badge !== undefined && (
                <span className="inline-flex items-center justify-center h-3.5 min-w-[14px] px-0.5 rounded-full bg-[var(--ide-border)] text-[9px] font-bold">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-1 text-[var(--ide-muted)] shrink-0">
          {tab === "TERMINAL" && (
            <>
              {/* Split terminal */}
              <button
                type="button"
                title={splitId ? "Unsplit terminal" : "Split terminal"}
                onClick={handleSplit}
                className={`h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] transition-colors ${splitId ? "text-violet-400" : ""}`}
              >
                <SplitSquareHorizontal className="h-3.5 w-3.5" />
              </button>
              {/* Kill terminal */}
              <button
                type="button"
                title="Kill terminal"
                onClick={() => activeTerm && killTerminal(activeTerm.id)}
                className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              {/* New terminal + profile dropdown */}
              <div ref={newTermRef} className="relative flex items-center">
                {/* + (left half) — creates terminal with current default profile */}
                <button
                  type="button"
                  title={`New Terminal (${defaultProfile})`}
                  onClick={newTerminal}
                  className="h-6 px-1 inline-flex items-center justify-center rounded-l hover:bg-[var(--ide-hover)] transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                {/* ▾ (right half) — opens profile picker */}
                <button
                  type="button"
                  title="Launch Profile..."
                  onClick={() => setShowNewTermMenu((v) => !v)}
                  className={`h-6 px-0.5 inline-flex items-center justify-center rounded-r hover:bg-[var(--ide-hover)] transition-colors ${showNewTermMenu ? "bg-[var(--ide-hover)]" : ""}`}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>

                {/* Dropdown menu — matches VS Code exactly */}
                {showNewTermMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl py-1 text-[12px]">

                    {/* Group 1 — terminal actions */}
                    <MenuItem label="New Terminal" shortcut="⌃⇧`" onClick={newTerminal} />
                    <MenuItem label="New Terminal Window" onClick={newTerminal} />
                    <MenuItem label="Split Terminal" onClick={() => { setShowNewTermMenu(false); handleSplit(); }} />

                    <Divider />

                    {/* Group 2 — AI */}
                    <MenuItem
                      label="GitHub Copilot CLI"
                      onClick={() => newTerminalWithProfile("GitHub Copilot CLI")}
                    />

                    <Divider />

                    {/* Group 3 — shell profiles */}
                    <MenuItem
                      label="PowerShell"
                      active={defaultProfile === "PowerShell"}
                      onClick={() => newTerminalWithProfile("PowerShell")}
                    />
                    <MenuItem
                      label="Git Bash"
                      active={defaultProfile === "Git Bash"}
                      onClick={() => newTerminalWithProfile("Git Bash")}
                    />
                    <MenuItem
                      label="Command Prompt"
                      active={defaultProfile === "Command Prompt"}
                      onClick={() => newTerminalWithProfile("Command Prompt")}
                    />
                    <MenuItem
                      label="JavaScript Debug Terminal"
                      onClick={() => newTerminalWithProfile("JavaScript Debug Terminal")}
                    />
                    <MenuItem
                      label="Split Terminal with Profile"
                      onClick={() => { setShowNewTermMenu(false); handleSplit(); }}
                    />

                    <Divider />

                    {/* Group 4 — settings */}
                    <MenuItem
                      label="Configure Terminal Settings"
                      icon={<Settings className="h-3 w-3" />}
                      onClick={() => setShowNewTermMenu(false)}
                    />
                    <MenuItem
                      label="Select Default Profile"
                      onClick={() => setShowNewTermMenu(false)}
                    />

                    <Divider />

                    {/* Group 5 — tasks */}
                    <MenuItem
                      label="Run Task..."
                      icon={<Play className="h-3 w-3" />}
                      onClick={() => setShowNewTermMenu(false)}
                    />
                    <MenuItem
                      label="Configure Tasks..."
                      onClick={() => setShowNewTermMenu(false)}
                    />
                  </div>
                )}
              </div>

              {/* ··· More actions */}
              <div ref={moreMenuRef} className="relative">
                <button
                  type="button"
                  title="More actions..."
                  onClick={() => setShowMoreMenu((v) => !v)}
                  className={`h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] transition-colors ${showMoreMenu ? "bg-[var(--ide-hover)]" : ""}`}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>

                {showMoreMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-60 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl py-1 text-[12px]">
                    <MenuItem label="Scroll to Previous Command" shortcut="Ctrl+↑" onClick={scrollToPrevCommand} />
                    <MenuItem label="Scroll to Next Command"     shortcut="Ctrl+↓" onClick={scrollToNextCommand} />
                    <MenuItem label="Clear Terminal"                                onClick={clearTerminalAction} />
                    <MenuItem label="Run Active File"                               onClick={runActiveFile} />
                    <MenuItem label="Run Selected Text"                             onClick={runSelectedText} />
                    <MenuItem label="Start Dictation"                               onClick={() => setShowMoreMenu(false)} />
                    <Divider />
                    <MenuItem label="Go to Recent Directory..." shortcut="Ctrl+G"       onClick={goToRecentDirectory} />
                    <MenuItem label="Run Recent Command..."     shortcut="Ctrl+Alt+R"   onClick={runRecentCommand} />
                  </div>
                )}
              </div>
            </>
          )}

          {/* Maximize / Restore panel */}
          {onMaximize && (
            <button
              type="button"
              title={maximized ? "Restore panel size" : "Maximize panel size"}
              onClick={onMaximize}
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] transition-colors"
            >
              {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}

          {/* Close panel */}
          {onClose && (
            <button
              type="button"
              title="Close panel"
              onClick={onClose}
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {tab === "TERMINAL" ? (
        <div className="flex flex-1 min-h-0">

          {/* Terminal instance list (VS Code left sidebar) */}
          <div className="w-[148px] shrink-0 border-r border-[var(--ide-border)] flex flex-col bg-[var(--ide-bg)] overflow-y-auto">
            <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-widest text-[var(--ide-muted)]">
              Terminals
            </div>
            {terminals.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => { setActiveId(t.id); inputRef.current?.focus(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setActiveId(t.id); inputRef.current?.focus(); } }}
                className={`group flex items-center justify-between px-2 py-1.5 text-[11px] w-full text-left cursor-pointer transition-colors ${
                  t.id === activeId
                    ? "bg-violet-600/20 text-[var(--ide-text)]"
                    : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Circle
                    className={`h-1.5 w-1.5 shrink-0 ${
                      t.id === activeId ? "fill-emerald-400 text-emerald-400" : "fill-[var(--ide-muted)] text-[var(--ide-muted)]"
                    }`}
                  />
                  <Server className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />
                  <span className="truncate">{t.name}</span>
                </div>
                <button
                  type="button"
                  title="Kill terminal"
                  onClick={(e) => { e.stopPropagation(); killTerminal(t.id); }}
                  className="h-3.5 w-3.5 inline-flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}

            {/* New terminal at bottom of list */}
            <button
              type="button"
              onClick={newTerminal}
              className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors border-t border-[var(--ide-border)] mt-auto"
            >
              <Plus className="h-3 w-3" />
              New Terminal
            </button>
          </div>

          {/* Terminal pane(s) */}
          <div className={`flex flex-1 min-w-0 ${splitId ? "divide-x divide-[var(--ide-border)]" : ""}`}>
            {/* Main (active) pane */}
            <div className="flex flex-col flex-1 min-w-0">
              {renderLines(activeTerm ?? terminals[0], true)}
            </div>

            {/* Split pane */}
            {splitTerm && (
              <div
                className="flex flex-col flex-1 min-w-0 cursor-pointer"
                onClick={() => { setActiveId(splitTerm.id); inputRef.current?.focus(); }}
              >
                {renderLines(splitTerm, activeId === splitTerm.id)}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Non-terminal panel tabs */
        <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[12px] text-[var(--ide-muted)]">
          {tab === "OUTPUT" && (
            <div>
              <span className="text-emerald-400">[Code Studio]</span> Workspace loaded.
            </div>
          )}
          {tab === "PROBLEMS" && (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
              <AlertCircle className="h-6 w-6 text-[var(--ide-muted)]" />
              <p>No problems detected in the workspace.</p>
            </div>
          )}
          {tab === "DEBUG CONSOLE" && (
            <div>
              <span className="text-sky-400">Debug console</span> ready. Start a debug session to see output here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TerminalDock;
