"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Loader2, Plus, FolderOpen, Search, Check, ChevronsUpDown, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useSessions } from "@/hooks/useSessions";
import { cn } from "@/lib/utils";

interface SessionSelectProps {
  projectId: number;
  /** Selected session ID (0 = "Create new") */
  value: number;
  onChange: (id: number, name?: string) => void;
  /** If provided, the new-session name field is pre-filled */
  newSessionName?: string;
  onNewNameChange?: (name: string) => void;
}

/**
 * Session selector + inline "create new session" input.
 *
 * Searchable, scrollable combobox that filters sessions by name.
 * When the user picks "Create new session", an inline text field appears
 * so they can name the new session.
 */
export function SessionSelect({
  projectId,
  value,
  onChange,
  newSessionName = "",
  onNewNameChange,
}: SessionSelectProps) {
  // Show all non-archived sessions (active + completed) so users can
  // continue generating into sessions that already have finished runs.
  const { sessions: allSessions, loading } = useSessions(projectId, undefined, "StoryMate");
  const sessions = allSessions.filter((s) => s.status !== "archived");

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setSearch("");
    }
  }, [open]);

  // Filtered sessions
  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) => s.session_name.toLowerCase().includes(q));
  }, [sessions, search]);

  // Display label for the trigger button
  const selectedSession = sessions.find((s) => s.id === value);
  const triggerLabel = showNew
    ? "Create new session"
    : selectedSession
      ? selectedSession.session_name
      : "Select or create a session…";

  const handlePick = (id: number) => {
    setShowNew(false);
    onChange(id);
    setOpen(false);
  };

  const handleNew = () => {
    setShowNew(true);
    onChange(0);
    setOpen(false);
  };

  if (!projectId) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5" /> Session
        </Label>
        <p className="text-xs text-slate-500 italic">Select a project first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5" /> Session
        </Label>
        {sessions.length > 0 && (
          <span className="text-[10px] text-slate-500">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex h-9 items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading sessions…
        </div>
      ) : (
        <>
          {/* Combobox trigger + dropdown */}
          <div className="relative" ref={containerRef}>
            {/* Trigger button */}
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className={cn(
                "flex h-9 w-full items-center justify-between rounded-md border px-3 py-2 text-sm",
                "bg-slate-800 border-slate-700 text-slate-100",
                "hover:bg-slate-700/50 transition-colors",
                "focus:outline-none focus:ring-1 focus:ring-slate-500",
                !selectedSession && !showNew && "text-slate-400",
              )}
            >
              <span className="truncate">{triggerLabel}</span>
              <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-slate-500" />
            </button>

            {/* Dropdown */}
            {open && (
              <div
                className={cn(
                  "absolute z-50 mt-1 w-full rounded-md border border-slate-700",
                  "bg-slate-800 shadow-lg shadow-black/40",
                  "animate-in fade-in-0 zoom-in-95 duration-100",
                )}
              >
                {/* Search input */}
                <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
                  <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  <input
                    ref={searchRef}
                    type="text"
                    placeholder="Search sessions…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="text-slate-500 hover:text-slate-300"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Scrollable options */}
                <div className="max-h-52 overflow-y-auto overscroll-contain py-1">
                  {/* Create-new option (always visible, not affected by filter) */}
                  <button
                    type="button"
                    onClick={handleNew}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-sm",
                      "text-indigo-400 hover:bg-slate-700/60 transition-colors",
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create new session
                  </button>

                  {/* Separator */}
                  {filtered.length > 0 && (
                    <div className="mx-2 my-1 border-t border-slate-700/60" />
                  )}

                  {/* Session list */}
                  {filtered.length === 0 && search.trim() ? (
                    <p className="px-3 py-3 text-xs text-slate-500 text-center">
                      No sessions matching &ldquo;{search}&rdquo;
                    </p>
                  ) : (
                    filtered.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handlePick(s.id)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                          "hover:bg-slate-700/60",
                          value === s.id
                            ? "text-slate-100"
                            : "text-slate-300",
                        )}
                      >
                        {/* Check icon for selected */}
                        <Check
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            value === s.id ? "text-indigo-400" : "text-transparent",
                          )}
                        />
                        <span className="font-medium truncate flex-1 text-left">
                          {s.session_name}
                        </span>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[9px] px-1 py-0 shrink-0",
                            s.total_stories > 0
                              ? "border-emerald-600 text-emerald-400"
                              : "border-slate-600 text-slate-400",
                          )}
                        >
                          {s.total_stories} stories
                        </Badge>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Inline new-session name input */}
          {showNew && (
            <div className="flex items-center gap-2 mt-2">
              <Input
                className="bg-slate-800 border-slate-700 text-slate-100 h-8 text-sm flex-1"
                placeholder="Session name (e.g. Sprint 5 – Payments)"
                value={newSessionName}
                onChange={(e) => onNewNameChange?.(e.target.value)}
                autoFocus
              />
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-400 hover:text-slate-200 h-8 px-2"
                onClick={() => {
                  setShowNew(false);
                  onChange(0);
                  onNewNameChange?.("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-slate-500">
        Sessions group related pipeline runs together. Leave empty to auto-create.
      </p>
    </div>
  );
}
