/**
 * daemon-download — fetch a short-lived installer download link for the local
 * daemon from the backend (which returns a Blob SAS URL). Used by the "Save to
 * Disk isn't available" notice so users can install the daemon in a click.
 */

import { getToken } from "@/lib/auth";

export type DaemonOS = "win" | "mac" | "linux";

export const OS_LABEL: Record<DaemonOS, string> = {
  win: "Windows",
  mac: "macOS",
  linux: "Linux",
};

/** Best-effort detection of the visitor's OS for a sensible default. */
export function detectOS(): DaemonOS {
  if (typeof navigator === "undefined") return "linux";
  const hay = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (hay.includes("win")) return "win";
  if (hay.includes("mac") || hay.includes("iphone") || hay.includes("ipad")) return "mac";
  return "linux";
}

/**
 * Newest published daemon version (from the blob manifest, via the backend).
 * Returns null on any failure so callers degrade gracefully — no update
 * button rather than a broken page.
 */
export async function getLatestDaemonVersion(): Promise<string | null> {
  try {
    const token = getToken();
    const res = await fetch(`/workspace-api/daemon/latest-version`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Ask the backend for a time-limited SAS download URL for the daemon binary. */
export async function getDaemonDownloadUrl(
  os: DaemonOS,
): Promise<{ url: string; filename: string; expires_in: number }> {
  const token = getToken();
  const res = await fetch(`/workspace-api/daemon/download-url?platform=${os}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = `Download link unavailable (${res.status}).`;
    try { const e = await res.json(); if (e?.detail) msg = e.detail; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}
