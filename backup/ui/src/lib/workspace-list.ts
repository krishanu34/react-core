/**
 * workspace-list — pure helpers that turn raw workspace rows into the list the
 * /workspaces page shows.
 *
 * Why this exists: the `workspaces` table is shared by two very different
 * writers.
 *
 *   1. Workspace Studio (the user clicking "New Workspace") — always writes a
 *      name AND an absolute local folder path.
 *   2. The agent (`claim_thread` in persistence/postgres_agent.py) — inserts a
 *      row per CHAT THREAD, with no name at all (the column defaults to '').
 *
 * Both are returned by GET /api/workspaces, so the page used to render every
 * agent thread the user had ever started as an "Untitled workspace" card. On a
 * second machine that is the whole list: nothing there was created on THIS
 * machine, so every card is a dead end.
 *
 * Rules applied here (presentation only — nothing is deleted server-side):
 *   • A row with no absolute local path is a thread handle, not a workspace →
 *     dropped. It cannot name a folder on ANY machine, so no client can open it.
 *   • Several rows pointing at the SAME folder collapse into one card (an agent
 *     thread and the workspace it ran in are the same folder to the user).
 *     The named row wins, then the most recent.
 *   • A card's title falls back to the folder's own name, so a real folder is
 *     never shown as "Untitled".
 *
 * Per-machine visibility (does this folder exist HERE?) is layered on top by
 * the page via the daemon's /fs/exists.
 */

/** Absolute path — Windows drive (C:\…), POSIX (/…), or UNC (\\server\…). */
const ABS_PATH = /^([A-Za-z]:[\\/]|\/|\\\\)/;

/** Row shape this module needs; a superset is fine. */
export interface WorkspaceListRow {
  id: number;
  name?: string;
  localPathLabel?: string;
  createdAt: number;
}

/** Trimmed path, or "" when absent. Quotes are stripped (Windows "Copy as path"). */
export function cleanPath(path: string | undefined | null): string {
  return (path ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

/** True when the string names an absolute folder on some machine. */
export function isAbsoluteLocalPath(path: string | undefined | null): boolean {
  return ABS_PATH.test(cleanPath(path));
}

/**
 * Comparison key for "the same folder". Separators and case are normalised
 * because Windows paths reach us both ways (C:\Foo vs C:/foo) and its file
 * system is case-insensitive; a trailing separator is not a difference.
 */
export function pathKey(path: string): string {
  return cleanPath(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The folder's own name — "proj" for C:\src\proj. */
export function folderName(path: string): string {
  const parts = pathKey(path).split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  // A bare drive root (C:/) has no folder name of its own — show the drive.
  return last.endsWith(":") ? last.toUpperCase() + "\\" : last;
}

/**
 * Title for a card: the given name, else the folder's name. Empty only when
 * the row has neither — those rows are dropped by `buildWorkspaceList`, so the
 * caller's "Untitled workspace" fallback is now a genuine last resort.
 */
export function displayName(ws: WorkspaceListRow): string {
  const name = (ws.name ?? "").trim();
  if (name) return name;
  const path = cleanPath(ws.localPathLabel);
  return path ? folderName(path) : "";
}

/**
 * Which of two rows for the same folder to keep: a named row beats an unnamed
 * one (the user typed that name), then the newer row.
 */
function preferred<T extends WorkspaceListRow>(a: T, b: T): T {
  const aNamed = Boolean((a.name ?? "").trim());
  const bNamed = Boolean((b.name ?? "").trim());
  if (aNamed !== bNamed) return aNamed ? a : b;
  return b.createdAt > a.createdAt ? b : a;
}

/**
 * Drop pathless agent-thread rows, collapse duplicate folders, and sort newest
 * first. Returns the kept rows plus how many raw rows each one absorbed, so the
 * page can explain the difference instead of silently showing fewer cards.
 */
export function buildWorkspaceList<T extends WorkspaceListRow>(
  rows: T[],
): { items: T[]; droppedPathless: number; mergedDuplicates: number } {
  const withPath = rows.filter((r) => isAbsoluteLocalPath(r.localPathLabel));
  const droppedPathless = rows.length - withPath.length;

  const byPath = new Map<string, T>();
  for (const row of withPath) {
    const key = pathKey(row.localPathLabel!);
    const existing = byPath.get(key);
    byPath.set(key, existing ? preferred(existing, row) : row);
  }

  const items = [...byPath.values()].sort((a, b) => b.createdAt - a.createdAt);
  return { items, droppedPathless, mergedDuplicates: withPath.length - items.length };
}
