/**
 * Write files from a Spec Execution response into the workspace.
 *
 * Writes to BOTH:
 *   1. IndexedDB (WsNode + WsFile) — so Explorer tree shows the files
 *   2. Local filesystem (via File System Access API) — if the workspace
 *      is linked to a local folder
 *
 * Reuses the same WsNode / WsFile types and putNodes/putFile helpers that
 * the Explorer and WorkspaceUploadZone use, so generated files appear in
 * the tree immediately after bumpTreeRevision().
 */
import {
  putNodes,
  putFile,
  getAllNodes,
  getFile,
  type WsNode,
  type WsFile,
} from "@/lib/db/workspaceStore";
import { writeClientWorkspaceFile } from "@/lib/workspace-api";
import type { SpecSubtaskOutput, SpecContextFile } from "@/lib/spec-api";

/* ── Language inference (fallback when API doesn't provide it) ────────── */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", java: "java", cs: "csharp", go: "go", rs: "rust", rb: "ruby",
  php: "php", json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
  html: "html", css: "css", scss: "scss", sql: "sql", sh: "shell",
  xml: "xml", txt: "plaintext",
};
const langOf = (p: string) =>
  EXT_LANG[p.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

/* ── Ensure all intermediate folder nodes exist ──────────────────────── */
function ensureFolders(
  allParts: string[],
  upTo: number,
  seen: Set<string>,
  nodes: WsNode[],
): void {
  for (let d = 1; d <= upTo; d++) {
    const fp = allParts.slice(0, d).join("/");
    if (!seen.has(fp)) {
      seen.add(fp);
      nodes.push({
        path: fp,
        type: "folder",
        parentPath: allParts.slice(0, d - 1).join("/"),
      });
    }
  }
}

/* ── Main writer ─────────────────────────────────────────────────────── */

export async function writeSpecFilesToWorkspace(
  workspaceId: number,
  output: SpecSubtaskOutput,
): Promise<{ fileCount: number; nodes: WsNode[] }> {
  const nodes: WsNode[] = [];
  const files: WsFile[] = [];
  const seen = new Set<string>();

  // Create folder nodes from the explicit folders list
  for (const folderPath of output.folders) {
    const parts = folderPath.split("/").filter(Boolean);
    ensureFolders(parts, parts.length, seen, nodes);
  }

  // Create file nodes + content
  for (const f of output.files) {
    const parts = f.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    // Ensure ancestor folders
    ensureFolders(parts, parts.length - 1, seen, nodes);

    const filePath = parts.join("/");
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    nodes.push({
      path: filePath,
      type: "file",
      parentPath: parts.slice(0, -1).join("/"),
    });

    files.push({
      path: filePath,
      content: f.content,
      lang: f.language || langOf(filePath),
      dirty: false,
      updatedAt: Date.now(),
    });
  }

  // ── 1. Write to IndexedDB (upsert — doesn't wipe existing files)
  if (nodes.length > 0) {
    await putNodes(workspaceId, nodes);
  }
  for (const file of files) {
    await putFile(workspaceId, file);
  }

  // ── 2. Write to local filesystem (if workspace is linked to a local folder)
  for (const file of files) {
    await writeClientWorkspaceFile(workspaceId, file.path, file.content);
  }

  return { fileCount: files.length, nodes };
}

/* ── Gather existing workspace files as context for the API ──────────── */

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot",
  "pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "bin",
]);
const isBinary = (p: string) => BINARY_EXTS.has(p.split(".").pop()?.toLowerCase() ?? "");

const MAX_CONTEXT_FILES = 50;
const MAX_FILE_SIZE = 100_000; // 100KB per file

export async function gatherWorkspaceContext(
  workspaceId: number,
): Promise<SpecContextFile[]> {
  const allNodes = await getAllNodes(workspaceId);
  const fileNodes = allNodes.filter((n) => n.type === "file" && !isBinary(n.path));

  const contextFiles: SpecContextFile[] = [];

  for (const node of fileNodes) {
    if (contextFiles.length >= MAX_CONTEXT_FILES) break;

    const wsFile = await getFile(workspaceId, node.path);
    if (!wsFile || !wsFile.content) continue;
    if (wsFile.content.length > MAX_FILE_SIZE) continue;

    contextFiles.push({
      path: wsFile.path,
      content: wsFile.content,
      language: wsFile.lang || langOf(wsFile.path),
    });
  }

  return contextFiles;
}
