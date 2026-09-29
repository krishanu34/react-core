"use client";

import { Check, ChevronDown, FolderGit2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createProject, listProjects, type Project } from "@/lib/api";

interface ProjectSwitcherProps {
  projectId: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
}

/**
 * Dropdown that scopes the conversation to a project. "No project" keeps the
 * agent org-wide. Supports inline creation.
 */
export function ProjectSwitcher({ projectId, onChange, disabled }: ProjectSwitcherProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function refresh() {
    try {
      setProjects(await listProjects());
    } catch {
      // Backend may be down; leave the list empty.
    }
  }

  const current = projects.find((p) => p.id === projectId) ?? null;

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const created = await createProject(name);
      setProjects((prev) => [created, ...prev]);
      onChange(created.id);
      setNewName("");
      setCreating(false);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-[var(--radius-bell-pill)] border border-bell-border bg-white px-3 py-1.5 text-sm text-bell-slate transition-colors hover:border-bell-blue disabled:opacity-50"
      >
        <FolderGit2 size={14} className="text-bell-blue" aria-hidden />
        <span className="max-w-[160px] truncate">
          {current ? current.name : "No project"}
        </span>
        <ChevronDown size={14} className="text-bell-muted" aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-30 mt-1 w-64 rounded-[var(--radius-bell)] border border-bell-border bg-white p-1 shadow-[var(--shadow-bell-md)]"
        >
          <Option
            label="No project"
            hint="Org-wide"
            selected={!projectId}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          />
          {projects.map((p) => (
            <Option
              key={p.id}
              label={p.name}
              hint={p.description ?? undefined}
              selected={p.id === projectId}
              onClick={() => {
                onChange(p.id);
                setOpen(false);
              }}
            />
          ))}

          <div className="my-1 border-t border-bell-border" />

          {creating ? (
            <div className="flex flex-col gap-1 p-1">
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") setCreating(false);
                  }}
                  placeholder="Project name"
                  className="flex-1 rounded-[var(--radius-bell)] border border-bell-border px-2 py-1 text-sm text-bell-ink focus:border-bell-blue focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  aria-label="Create project"
                  className="rounded-[var(--radius-bell)] p-1 text-bell-blue hover:bg-bell-blue-soft"
                >
                  <Check size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  aria-label="Cancel"
                  className="rounded-[var(--radius-bell)] p-1 text-bell-muted hover:bg-bell-chrome"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
              {error && <p className="px-1 text-xs text-red-600">{error}</p>}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-[var(--radius-bell)] px-2 py-1.5 text-left text-sm text-bell-blue hover:bg-bell-blue-soft"
            >
              <Plus size={14} aria-hidden />
              New project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[var(--radius-bell)] px-2 py-1.5 text-left text-sm hover:bg-bell-chrome"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected && <Check size={14} className="text-bell-blue" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-bell-ink">{label}</span>
        {hint && <span className="block truncate text-xs text-bell-muted">{hint}</span>}
      </span>
    </button>
  );
}
