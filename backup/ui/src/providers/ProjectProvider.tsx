"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDbProjects, type DbProject } from "@/hooks/useDbProjects";
import { getUser } from "@/lib/auth";

export interface ProjectSelection {
  projectId: number;
  projectName: string;
  selectedStoryIds: Set<number>;
  selectedDocIds: Set<number>;
}

interface ProjectContextValue {
  projects: DbProject[];
  loading: boolean;
  refresh: () => void;
  selectedProjectId: number;
  selectedProject: DbProject | null;
  setSelectedProjectId: (id: number) => void;
  projectSelection: ProjectSelection | null;
  setProjectSelection: (sel: ProjectSelection | null) => void;
  canCreateProject: boolean;
}

const STORAGE_KEY = "devaccel_selected_project_id";

function readStoredProjectId(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : 0;
  } catch { return 0; }
}

function writeStoredProjectId(id: number) {
  if (typeof window === "undefined") return;
  try {
    if (id > 0) localStorage.setItem(STORAGE_KEY, String(id));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useGlobalProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useGlobalProject must be used within <ProjectProvider>");
  return ctx;
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { projects, loading, refresh } = useDbProjects();
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<number>(0);
  const [projectSelection, setProjectSelection] = useState<ProjectSelection | null>(null);
  const [canCreateProject, setCanCreateProject] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    const u = getUser();
    setCanCreateProject(!!u?.is_admin || (u?.roles ?? []).includes("create_project"));
  }, []);

  // This product has no projects (tenancy is the user — see useDbProjects), so
  // there is nothing to restore. We actively CLEAR the key instead: it survives
  // from the DevAccel app on the same origin, and a stale id here was being
  // passed to workspace-scoped APIs as if it were a workspace id.
  useEffect(() => {
    writeStoredProjectId(0);
  }, []);

  useEffect(() => {
    if (!loading && projects.length > 0 && !initialised.current) {
      initialised.current = true;
      const active = projects.filter((p) => !p.archived);
      if (active.length > 0 && selectedProjectId === 0) {
        const stored = readStoredProjectId();
        const valid = stored > 0 && active.some((p) => p.id === stored);
        const id = valid ? stored : active[0].id;
        setSelectedProjectIdRaw(id);
        writeStoredProjectId(id);
      }
    }
  }, [loading, projects, selectedProjectId]);

  const setSelectedProjectId = useCallback((id: number) => {
    setSelectedProjectIdRaw(id);
    writeStoredProjectId(id);
    setProjectSelection(null);
  }, []);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      loading,
      refresh,
      selectedProjectId,
      selectedProject,
      setSelectedProjectId,
      projectSelection,
      setProjectSelection,
      canCreateProject,
    }),
    [projects, loading, refresh, selectedProjectId, selectedProject, setSelectedProjectId, projectSelection, canCreateProject],
  );

  return (
    <ProjectContext.Provider value={value}>
      {children}
    </ProjectContext.Provider>
  );
}
