"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Check,
  FolderKanban,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useGlobalProject } from "@/providers/ProjectProvider";

export function GlobalProjectDropdown() {
  const router = useRouter();
  const {
    projects,
    loading,
    refresh,
    selectedProjectId,
    selectedProject,
    setSelectedProjectId,
    canCreateProject,
  } = useGlobalProject();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const active = projects.filter((p) => !p.archived);
  const filtered = active.filter(
    (p) => p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={selectedProject ? selectedProject.name : "Select a project"}
        onClick={() => { setOpen((o) => !o); setSearch(""); }}
        className="flex items-center gap-2 h-8 px-3 rounded-lg bg-slate-900 border border-slate-700 hover:border-slate-500 text-sm transition-colors"
      >
        <FolderKanban className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
        <span className="truncate max-w-[160px] text-slate-200 text-xs font-medium">
          {loading
            ? "Loading…"
            : selectedProject
              ? selectedProject.name
              : "Select project…"}
        </span>
        <ChevronDown className={`h-3 w-3 text-slate-500 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-xl py-1">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800">
            <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => refresh()}
              title="Refresh"
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-slate-800 text-slate-500 hover:text-slate-300"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Project list */}
          <div className="max-h-64 overflow-auto py-1">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading projects…
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500">
                {search ? "No matching projects." : "No projects yet."}
              </p>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setSelectedProjectId(p.id); setOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    p.id === selectedProjectId
                      ? "bg-indigo-600/15 text-indigo-400"
                      : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                  }`}
                >
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.description && (
                    <span className="text-[10px] text-slate-500 truncate max-w-[80px]">{p.description}</span>
                  )}
                  {p.id === selectedProjectId && (
                    <Check className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>

          {/* Create Project */}
          {canCreateProject && (
            <div className="border-t border-slate-800 pt-1 pb-0.5">
              <button
                type="button"
                onClick={() => { setOpen(false); router.push("/projects/new"); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-indigo-400 hover:bg-slate-800 hover:text-indigo-300 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Create Project
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
