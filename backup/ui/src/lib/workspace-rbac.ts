import { getUser, hasRole } from "@/lib/auth";

export const WORKSPACE_STUDIO_ROLE = "workspace_studio";

export function canAccessWorkspaceStudio(): boolean {
  const user = getUser();
  return !!user && (user.role === "admin" || hasRole(WORKSPACE_STUDIO_ROLE));
}
