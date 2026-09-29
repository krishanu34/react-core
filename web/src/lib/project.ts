const STORAGE_KEY = "react-core.project_id";

export function loadProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveProjectId(projectId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (projectId) window.localStorage.setItem(STORAGE_KEY, projectId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage may be disabled — silently no-op
  }
}
