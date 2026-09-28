/**
 * src/lib/launch-mode.ts
 * Detect and manage the launch mode (standalone vs DevAccel integrated).
 */

export type LaunchMode = "standalone" | "integrated";

export interface IntegrationParams {
  token: string;
  projectId: string;
  mode: "integrated";
}

/**
 * Detect launch mode from URL query parameters.
 * If ?mode=integrated&token=... is present, we're in integrated mode.
 */
export function detectLaunchMode(): LaunchMode {
  if (typeof window === "undefined") return "standalone";
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "integrated" && params.get("token")) {
    return "integrated";
  }
  return "standalone";
}

/**
 * Extract integration parameters from URL if present.
 */
export function getIntegrationParams(): IntegrationParams | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const projectId = params.get("project_id");
  if (token && projectId && params.get("mode") === "integrated") {
    return { token, projectId, mode: "integrated" };
  }
  return null;
}

/**
 * Check if currently in integrated mode based on stored auth user data.
 */
export function isIntegratedMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const token = localStorage.getItem("auth_token");
    if (!token) return false;
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64));
    return payload.launch_mode === "integrated";
  } catch {
    return false;
  }
}
