"use client";

/**
 * WorkspaceUploadZone — drag-drop or click-to-upload for workspace creation
 * and in-IDE imports.
 *
 * Accepts a ZIP file or an entire folder (webkitdirectory). Parses client-side
 * with jszip and writes all nodes + file contents into IndexedDB.
 *
 * Path handling:
 *   • ZIP  — strips the single top-level wrapper folder automatically
 *            (e.g. GitHub exports: "repo-main/") regardless of whether the ZIP
 *            includes an explicit folder entry for that root.
 *   • Folder — strips the root folder name (webkitRelativePath root segment)
 *              so files start at the workspace root.
 *   • targetPath — when provided, ALL paths are prefixed with it.
 *              E.g. targetPath="backend" → every file lands under "backend/…".
 *
 * Calling onDone also passes back the full WsNode list so callers can trigger
 * Explorer refresh (e.g. via bumpTreeRevision) without a page reload.
 */
import React, { useCallback, useRef, useState } from "react";
import JSZip from "jszip";
import { Upload, FolderOpen, FileArchive, CheckCircle2, Loader2, X, AlertTriangle } from "lucide-react";
import {
  putNodes,
  putFile,
  getAllNodes,
  type WsNode,
  type WsFile,
} from "@/lib/db/workspaceStore";
import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";

/* ── Language inference ────────────────────────────────────────────────── */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", java: "java", cs: "csharp", go: "go", rs: "rust", rb: "ruby",
  php: "php", json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
  html: "html", css: "css", scss: "scss", sql: "sql", sh: "shell",
  xml: "xml", txt: "plaintext",
};
const langOf = (p: string) =>
  EXT_LANG[p.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

/* ── Binary extension guard ────────────────────────────────────────────── */
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot",
  "pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "bin",
]);
const isBinary = (p: string) => BINARY_EXTS.has(p.split(".").pop()?.toLowerCase() ?? "");

/* ── Noise directories to skip in both ZIP and folder imports ──────────── */
const SKIP_DIRS = new Set([
  "__MACOSX", ".git", "node_modules", "__pycache__",
  ".next", "dist", "build", "coverage", ".venv", "venv",
]);
const shouldSkipSegment = (s: string) => SKIP_DIRS.has(s) || s === ".DS_Store";

type Mode = "idle" | "processing" | "conflict" | "done" | "error";
type ConflictStrategy = "overwrite" | "skip" | "rename";

/** Appends " (1)", " (2)"… before the extension until `path` is not in `taken`. */
function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) return path;
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : path.slice(0, lastSlash + 1);
  const base = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
  let n = 1;
  let candidate = `${dir}${stem} (${n})${ext}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${dir}${stem} (${n})${ext}`;
  }
  return candidate;
}

/* ── Recursively collect files via File System Access API (button click) ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readDirHandle(handle: any, pathPrefix: string, out: Array<{ file: File; relativePath: string }>): Promise<void> {
  for await (const entry of handle.values()) {
    const childPath = `${pathPrefix}/${entry.name}`;
    if (entry.kind === "file") {
      const file: File = await entry.getFile();
      out.push({ file, relativePath: childPath });
    } else if (entry.kind === "directory") {
      await readDirHandle(entry, childPath, out);
    }
  }
}

/* ── Recursively collect all files from a drag-dropped directory entry ──── */
async function readDirEntry(
  entry: FileSystemDirectoryEntry,
  pathPrefix: string,
  out: Array<{ file: File; relativePath: string }>,
): Promise<void> {
  const reader = entry.createReader();
  let chunk: FileSystemEntry[];
  do {
    // readEntries returns at most 100 entries per call; loop until empty
    chunk = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    await Promise.all(
      chunk.map(async (child) => {
        const childPath = `${pathPrefix}/${child.name}`;
        if (child.isFile) {
          const file = await new Promise<File>((resolve, reject) =>
            (child as FileSystemFileEntry).file(resolve, reject),
          );
          out.push({ file, relativePath: childPath });
        } else if (child.isDirectory) {
          await readDirEntry(child as FileSystemDirectoryEntry, childPath, out);
        }
      }),
    );
  } while (chunk.length > 0);
}

/* ── Helper: ensure all intermediate folder nodes exist ────────────────── */
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
      nodes.push({ path: fp, type: "folder", parentPath: allParts.slice(0, d - 1).join("/") });
    }
  }
}

/* ========================================================================== */
export function WorkspaceUploadZone({
  workspaceId,
  targetPath = "",
  onDone,
}: {
  workspaceId: number;
  /**
   * When set, every imported path is prefixed with this value.
   * E.g. targetPath="src/backend" puts files under "src/backend/…".
   * Leave empty (default) to import directly into the workspace root.
   */
  targetPath?: string;
  /**
   * sourceName — the ZIP filename (without extension) or the root folder name
   * stripped of the leading dot (if any). Useful for auto-filling workspace name
   * and path label in the creation modal.
   */
  onDone: (result: { fileCount: number; nodes: WsNode[]; sourceName?: string }) => void;
}) {
  const [mode, setMode]       = useState<Mode>("idle");
  const [progress, setProgress] = useState("");
  const [fileCount, setFileCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [diskWriteFailures, setDiskWriteFailures] = useState(0);
  const [error, setError]     = useState("");
  const [dragging, setDragging] = useState(false);
  const zipRef    = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  /* ── Pending import awaiting a conflict-resolution choice ────────────── */
  const [pending, setPending] = useState<{
    nodes: WsNode[];
    files: WsFile[];
    sourceName?: string;
    conflictCount: number;
  } | null>(null);

  /* ── Core write: merge fresh nodes + content into the workspace ──────── */
  const storeItems = useCallback(
    async (nodes: WsNode[], files: WsFile[], sourceName?: string, strategy?: ConflictStrategy) => {
      const existingNodes = await getAllNodes(workspaceId).catch(() => []);
      const existingPaths = new Set(existingNodes.map((n) => n.path));

      const conflictingFilePaths = files
        .filter((f) => existingPaths.has(f.path))
        .map((f) => f.path);

      // First pass with no strategy chosen yet — pause and ask the user.
      if (conflictingFilePaths.length > 0 && !strategy) {
        setPending({ nodes, files, sourceName, conflictCount: conflictingFilePaths.length });
        setMode("conflict");
        return;
      }

      let finalNodes = nodes;
      let finalFiles = files;

      if (strategy === "skip" && conflictingFilePaths.length > 0) {
        const skip = new Set(conflictingFilePaths);
        finalFiles = files.filter((f) => !skip.has(f.path));
        finalNodes = nodes.filter((n) => !(n.type === "file" && skip.has(n.path)));
      } else if (strategy === "rename" && conflictingFilePaths.length > 0) {
        const taken = new Set([...existingPaths, ...nodes.map((n) => n.path)]);
        const remap = new Map<string, string>();
        finalFiles = files.map((f) => {
          if (!existingPaths.has(f.path)) return f;
          const next = uniquePath(f.path, taken);
          taken.add(next);
          remap.set(f.path, next);
          return { ...f, path: next };
        });
        finalNodes = nodes.map((n) =>
          n.type === "file" && remap.has(n.path) ? { ...n, path: remap.get(n.path)! } : n,
        );
      }
      // "overwrite" (or no conflicts): finalNodes/finalFiles as-is — put() replaces
      // any existing entry at the same path, everything else in the workspace is untouched.

      setProgress(`Storing ${finalNodes.length} items…`);
      await putNodes(workspaceId, finalNodes);

      // Mirror to the live filesystem when this workspace has local access —
      // via the daemon (HTTP/VM) OR the browser FS handle (HTTPS/localhost).
      // Otherwise imported files only ever existed in IndexedDB and would vanish
      // the next time the folder is rescanned from disk.
      const access = resolveWorkspaceFileAccess(workspaceId);
      let diskFailures = 0;
      if (access) {
        for (const n of finalNodes) {
          if (n.type === "folder") {
            await access.create(n.path, "folder").catch(() => { diskFailures++; });
          }
        }
      }

      let saved = 0;
      for (const f of finalFiles) {
        await putFile(workspaceId, f);
        // Binary content isn't decoded into IDB (stored as a placeholder), so
        // there are no real bytes to write to disk for it — skip those.
        if (access && f.content !== "(binary)") {
          await access.write(f.path, f.content).catch(() => { diskFailures++; });
        }
        saved++;
        if (saved % 20 === 0) setProgress(`Storing ${saved} of ${finalFiles.length} files…`);
      }
      setFileCount(finalFiles.length);
      setDiskWriteFailures(diskFailures);
      setMode("done");
      setPending(null);
      onDone({ fileCount: finalFiles.length, nodes: finalNodes, sourceName });
    },
    [workspaceId, onDone],
  );

  const resolveConflict = useCallback(
    (strategy: ConflictStrategy) => {
      if (!pending) return;
      setMode("processing");
      void storeItems(pending.nodes, pending.files, pending.sourceName, strategy);
    },
    [pending, storeItems],
  );

  /* ── ZIP processing ─────────────────────────────────────────────────── */
  const processZip = useCallback(
    async (file: File) => {
      setMode("processing");
      setProgress("Reading ZIP…");
      try {
        const zip = await JSZip.loadAsync(file);
        const nodes: WsNode[] = [];
        const files: WsFile[] = [];
        const seen = new Set<string>();

        const rawKeys = Object.keys(zip.files);
        let skippedFiles = 0;

        // Detect a single top-level wrapper folder (e.g. GitHub export "repo-main/").
        // Only strip when EVERY entry shares that single root — no explicit folder entry
        // required (fixes inconsistency with ZIPs that omit the root entry).
        const topSegments = new Set(
          rawKeys.map((k) => k.split("/")[0]).filter((s) => Boolean(s) && s !== "__MACOSX"),
        );
        const wrapperPrefix = topSegments.size === 1 ? `${[...topSegments][0]}/` : "";

        // Pre-seed targetPath ancestor nodes so they appear in the Explorer
        const tParts = targetPath.split("/").filter(Boolean);
        ensureFolders(tParts, tParts.length, seen, nodes);

        // Sort ensures parent folders are processed before children
        const entries = Object.entries(zip.files).sort(([a], [b]) => a.localeCompare(b));
        const totalFiles = entries.filter(([name, e]) => !name.endsWith("/") && !e.dir).length;

        for (const [rawName, entry] of entries) {
          // Strip the wrapper prefix when present
          const stripped = wrapperPrefix && rawName.startsWith(wrapperPrefix)
            ? rawName.slice(wrapperPrefix.length)
            : rawName;
          if (!stripped) continue;

          // Normalise: remove trailing slash, split
          const relParts = stripped.replace(/\/$/, "").split("/").filter(Boolean);
          if (relParts.length === 0) continue;

          // Drop entries inside noise directories
          if (relParts.some(shouldSkipSegment)) {
            if (!stripped.endsWith("/") && !entry.dir) skippedFiles++;
            continue;
          }

          const isDir = stripped.endsWith("/");
          const allParts = [...tParts, ...relParts];

          if (isDir) {
            ensureFolders(allParts, allParts.length, seen, nodes);
            continue;
          }

          // File — ensure all ancestor folders exist first
          ensureFolders(allParts, allParts.length - 1, seen, nodes);

          const filePath = allParts.join("/");
          if (seen.has(filePath)) continue;
          seen.add(filePath);
          nodes.push({
            path: filePath,
            type: "file",
            parentPath: allParts.slice(0, -1).join("/"),
          });

          const content = isBinary(filePath)
            ? "(binary)"
            : await entry.async("string").catch(() => "");
          files.push({
            path: filePath,
            content,
            lang: isBinary(filePath) ? "plaintext" : langOf(filePath),
            dirty: false,
            updatedAt: Date.now(),
          });
          if (files.length % 5 === 0 || files.length === totalFiles) {
            setProgress(`Extracting ${files.length} of ${totalFiles} files…`);
          }
        }

        // Derive a friendly name: ZIP filename without extension
        const sourceName = file.name.replace(/\.zip$/i, "");
        setSkippedCount(skippedFiles);
        await storeItems(nodes, files, sourceName);
      } catch (e) {
        setMode("error");
        setPending(null);
        setError(`ZIP parse failed: ${(e as Error).message}`);
      }
    },
    [storeItems, targetPath],
  );

  /* ── Folder processing (webkitdirectory) ──────────────────────────────
     Takes a PLAIN ARRAY, not the input's FileList: a FileList is live, and
     the onChange handler clears the input right after calling us — with a
     FileList reference the first `await` below would hand control back, the
     list would empty, and the import silently truncated to ONE file. */
  const processFolder = useCallback(
    async (fileArr: File[]) => {
      setMode("processing");
      setProgress("Reading folder…");
      try {
        const nodes: WsNode[] = [];
        const files: WsFile[] = [];
        const seen = new Set<string>();
        let skipped = 0;

        const tParts = targetPath.split("/").filter(Boolean);
        ensureFolders(tParts, tParts.length, seen, nodes);
        const totalFiles = fileArr.length;

        for (let i = 0; i < fileArr.length; i++) {
          const f = fileArr[i];
          // webkitRelativePath = "rootFolderName/sub/dir/file.ts"
          // Slice off the root folder name so paths start at the workspace root
          // (the workspace IS the selected folder, not a child of it).
          const rel = (f as File & { webkitRelativePath: string }).webkitRelativePath;
          const relParts = rel.split("/").slice(1).filter(Boolean);
          if (relParts.length === 0) continue;

          // Drop entries inside noise directories
          if (relParts.some(shouldSkipSegment)) { skipped++; continue; }

          const allParts = [...tParts, ...relParts];

          // Ensure ancestor folder nodes
          ensureFolders(allParts, allParts.length - 1, seen, nodes);

          const filePath = allParts.join("/");
          if (seen.has(filePath)) continue;
          seen.add(filePath);
          nodes.push({
            path: filePath,
            type: "file",
            parentPath: allParts.slice(0, -1).join("/"),
          });

          const content = isBinary(filePath) ? "(binary)" : await f.text().catch(() => "");
          files.push({
            path: filePath,
            content,
            lang: isBinary(filePath) ? "plaintext" : langOf(filePath),
            dirty: false,
            updatedAt: Date.now(),
          });
          if (files.length % 5 === 0 || files.length === totalFiles) {
            setProgress(`Extracting ${files.length} of ${totalFiles} files…`);
          }
        }

        // Derive a friendly name: the root folder segment from the first file's webkitRelativePath
        const firstRel = fileArr[0]
          ? (fileArr[0] as File & { webkitRelativePath: string }).webkitRelativePath
          : "";
        const sourceName = firstRel.split("/")[0] || undefined;
        setSkippedCount(skipped);
        await storeItems(nodes, files, sourceName);
      } catch (e) {
        setMode("error");
        setPending(null);
        setError(`Folder read failed: ${(e as Error).message}`);
      }
    },
    [storeItems, targetPath],
  );

  /* ── Folder entries processing (from drag-drop via FileSystem Entry API) */
  const processFolderEntries = useCallback(
    async (entries: Array<{ file: File; relativePath: string }>, rootName: string) => {
      setMode("processing");
      setProgress("Reading folder…");
      try {
        const nodes: WsNode[] = [];
        const files: WsFile[] = [];
        const seen = new Set<string>();

        const tParts = targetPath.split("/").filter(Boolean);
        ensureFolders(tParts, tParts.length, seen, nodes);
        const totalFiles = entries.length;

        let skipped = 0;
        for (const { file, relativePath } of entries) {
          // relativePath = "rootFolder/sub/dir/file.ts" — strip the root folder segment
          const relParts = relativePath.split("/").slice(1).filter(Boolean);
          if (relParts.length === 0) continue;
          if (relParts.some(shouldSkipSegment)) { skipped++; continue; }

          const allParts = [...tParts, ...relParts];
          ensureFolders(allParts, allParts.length - 1, seen, nodes);

          const filePath = allParts.join("/");
          if (seen.has(filePath)) continue;
          seen.add(filePath);
          nodes.push({ path: filePath, type: "file", parentPath: allParts.slice(0, -1).join("/") });

          const content = isBinary(filePath) ? "(binary)" : await file.text().catch(() => "");
          files.push({
            path: filePath,
            content,
            lang: isBinary(filePath) ? "plaintext" : langOf(filePath),
            dirty: false,
            updatedAt: Date.now(),
          });
          if (files.length % 5 === 0 || files.length === totalFiles) {
            setProgress(`Extracting ${files.length} of ${totalFiles} files…`);
          }
        }

        setSkippedCount(skipped);
        await storeItems(nodes, files, rootName);
      } catch (e) {
        setMode("error");
        setPending(null);
        setError(`Folder read failed: ${(e as Error).message}`);
      }
    },
    [storeItems, targetPath],
  );

  /* ── Drag-drop ──────────────────────────────────────────────────────── */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;

      // ── Collect everything synchronously before any await.
      // DataTransferItemList is neutered after the event yields.
      let zipFile: File | null = null;
      const fsEntries: FileSystemEntry[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "file") continue;

        // Grab the FileSystem entry (works for both files and directories)
        if (typeof item.webkitGetAsEntry === "function") {
          const entry = item.webkitGetAsEntry();
          if (entry) fsEntries.push(entry);
        }

        // Check for a ZIP file
        const f = item.getAsFile();
        if (f && f.name.toLowerCase().endsWith(".zip") && !zipFile) {
          zipFile = f;
        }
      }

      // ── ZIP takes priority ──────────────────────────────────────────
      if (zipFile) {
        await processZip(zipFile);
        return;
      }

      // ── Recursively read dropped folder(s) via FileSystem Entry API ──
      if (fsEntries.length > 0) {
        const collected: Array<{ file: File; relativePath: string }> = [];
        const rootName = fsEntries[0].name;

        for (const entry of fsEntries) {
          if (entry.isDirectory) {
            await readDirEntry(entry as FileSystemDirectoryEntry, entry.name, collected);
          } else {
            const file = await new Promise<File>((res, rej) =>
              (entry as FileSystemFileEntry).file(res, rej),
            );
            // Single file drop: prefix name so slice(1) leaves just the filename
            collected.push({ file, relativePath: `${entry.name}/${entry.name}` });
          }
        }

        if (collected.length > 0) {
          await processFolderEntries(collected, rootName);
          return;
        }
      }

      // ── Fallback: browsers without FileSystem Entry API ─────────────
      if (e.dataTransfer.files.length > 0) {
        await processFolder(Array.from(e.dataTransfer.files));
      }
    },
    [processZip, processFolder, processFolderEntries],
  );

  /* ── Upload Folder button: showDirectoryPicker → webkitdirectory fallback */
  const handleFolderButtonClick = useCallback(async () => {
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
        const collected: Array<{ file: File; relativePath: string }> = [];
        await readDirHandle(dirHandle, dirHandle.name, collected);
        if (collected.length > 0) {
          await processFolderEntries(collected, dirHandle.name);
        }
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // user cancelled
        // Any other error: fall through to input
      }
    }
    // Firefox / browsers without showDirectoryPicker
    folderRef.current?.click();
  }, [processFolderEntries]);

  const reset = () => {
    setMode("idle"); setProgress(""); setFileCount(0); setError("");
    setPending(null); setDiskWriteFailures(0); setSkippedCount(0);
  };

  /* ── Render ─────────────────────────────────────────────────────────── */
  if (mode === "conflict" && pending) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <div>
          <p className="text-sm font-medium text-amber-300">
            {pending.conflictCount} file{pending.conflictCount === 1 ? "" : "s"} already exist{pending.conflictCount === 1 ? "s" : ""}
          </p>
          <p className="mt-1 text-xs text-[var(--ide-muted)]">
            Choose how to handle the conflicting files. This choice applies to all of them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => resolveConflict("overwrite")}
            className="h-8 px-3 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            Overwrite
          </button>
          <button
            type="button"
            onClick={() => resolveConflict("skip")}
            className="h-8 px-3 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => resolveConflict("rename")}
            className="h-8 px-3 rounded-md border border-violet-500 bg-violet-600/20 text-xs text-violet-300 hover:bg-violet-600/30 transition-colors"
          >
            Rename
          </button>
        </div>
        <button type="button" onClick={reset} className="text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] underline">
          Cancel import
        </button>
      </div>
    );
  }

  if (mode === "done") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-8 text-center">
        <CheckCircle2 className="h-10 w-10 text-emerald-400" />
        <p className="text-sm font-medium text-emerald-300">{fileCount} files imported</p>
        {skippedCount > 0 && (
          <p className="text-xs text-[var(--ide-muted)]">
            {skippedCount} file{skippedCount === 1 ? "" : "s"} in dependency/build folders
            (node_modules, .git, dist, build, .venv, …) were skipped by design.
          </p>
        )}
        {targetPath && (
          <p className="text-xs text-emerald-500/80">Stored under <code className="font-mono">{targetPath}/</code></p>
        )}
        {diskWriteFailures > 0 && (
          <p className="text-xs text-amber-400">
            {diskWriteFailures} file{diskWriteFailures === 1 ? "" : "s"} couldn&apos;t be written to the local folder
            (permission may have been revoked) — reopen the folder to grant access again.
          </p>
        )}
        <button type="button" onClick={reset} className="text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] underline">
          Upload different files
        </button>
      </div>
    );
  }

  if (mode === "processing") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--ide-border)] bg-[var(--ide-surface)] p-8 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
        <p className="text-sm text-[var(--ide-text)]">{progress}</p>
      </div>
    );
  }

  if (mode === "error") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/40 bg-red-950/20 p-8 text-center">
        <X className="h-8 w-8 text-red-400" />
        <p className="text-sm text-red-300">{error}</p>
        <button type="button" onClick={reset} className="text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={onDrop}
      className={`flex flex-col items-center gap-4 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
        dragging ? "border-violet-500 bg-violet-900/10" : "border-[var(--ide-border)] bg-[var(--ide-hover)] hover:border-[var(--ide-muted)]"
      }`}
    >
      <Upload className="h-8 w-8 text-[var(--ide-muted)]" />
      <div>
        <p className="text-sm font-medium text-[var(--ide-text)]">Drop a ZIP or folder here</p>
        <p className="mt-1 text-xs text-[var(--ide-muted)]">or use the buttons below</p>
        {targetPath && (
          <p className="mt-1 text-[11px] text-violet-400/80">
            Files will be placed under <code className="font-mono">{targetPath}/</code>
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => zipRef.current?.click()}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
        >
          <FileArchive className="h-3.5 w-3.5 text-violet-400" /> Upload ZIP
        </button>
        <button
          type="button"
          onClick={handleFolderButtonClick}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
        >
          <FolderOpen className="h-3.5 w-3.5 text-amber-400" /> Upload Folder
        </button>
      </div>

      <input
        ref={zipRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) processZip(f); e.target.value = ""; }}
      />
      <input
        ref={folderRef}
        type="file"
        className="hidden"
        // @ts-expect-error — webkitdirectory is not in standard TS types
        webkitdirectory=""
        onChange={(e) => {
          // Snapshot BEFORE clearing: e.target.files is a LIVE FileList, and
          // resetting the input mid-parse empties it — which used to truncate
          // whole-folder imports to a single file.
          const snapshot = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (snapshot.length) void processFolder(snapshot);
        }}
      />
    </div>
  );
}

export default WorkspaceUploadZone;
