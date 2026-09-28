"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ExternalLink, Pencil } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDbProjects } from "@/hooks/useDbProjects";
import { getUser } from "@/lib/auth";

interface ProjectSelectProps {
  value:    number;
  onChange: (id: number) => void;
  label?:   string;
  hint?:    string;
}

export function ProjectSelect({
  value,
  onChange,
  label = "Project",
  hint,
}: ProjectSelectProps) {
  const { projects, loading } = useDbProjects();
  const initialised = useRef(false);

  // Defer auth check to avoid SSR/client hydration mismatch
  // (getUser reads localStorage which is unavailable on the server)
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    const u = getUser();
    setCanCreate(!!u?.is_admin || (u?.roles ?? []).includes("create_project"));
    setCanEdit(!!u?.is_admin || (u?.roles ?? []).includes("edit_project"));
  }, []);

  // Auto-select first project once list has loaded, but only if no
  // valid project is already selected (e.g. via URL query params).
  useEffect(() => {
    if (!loading && projects.length > 0 && !initialised.current) {
      initialised.current = true;
      // If the parent already holds a valid project id, keep it.
      const alreadyValid = value > 0 && projects.some((p) => p.id === value);
      if (!alreadyValid) {
        onChange(projects[0].id);
      }
    }
  }, [loading, projects, onChange, value]);

  const options = useMemo(
    () =>
      projects
        .filter((p) => !p.archived)
        .map((p) => ({
          value: String(p.id),
          label: p.name,
          sublabel: `#${p.id}`,
        })),
    [projects],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {(canCreate || canEdit) && (
          <div className="flex items-center gap-3">
            {canEdit && value > 0 && (
              <Link
                href={`/projects/${value}/edit`}
                className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <Pencil className="h-3 w-3" /> Edit selected
              </Link>
            )}
            {canCreate && (
              <Link
                href="/projects/new"
                className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <ExternalLink className="h-3 w-3" /> Manage projects
              </Link>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex h-9 items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
        </div>
      ) : projects.length > 0 ? (
        <SearchableSelect
          options={options}
          value={String(value)}
          onChange={(v) => onChange(Number(v))}
          placeholder="Select project…"
          searchPlaceholder="Search projects…"
          emptyMessage="No matching projects."
        />
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-slate-500 italic">No projects yet.</p>
          {canCreate && (
            <Link
              href="/projects/new"
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors underline-offset-2 hover:underline"
            >
              Create your first project →
            </Link>
          )}
        </div>
      )}

      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}
