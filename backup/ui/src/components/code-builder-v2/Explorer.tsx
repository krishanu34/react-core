"use client";

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { CBv2FileNode, CBv2WorkspaceAnalysisStatus, CBv2WorkspaceSource } from "@/types/code-builder-v2";
import {
  createGitRepoFile,
  deleteGitRepoFile,
  renameGitRepoFile,
  uploadToWorkspace,
  uploadFolderToWorkspace,
  deleteWorkspaceSource,
  clearAllWorkspaceSources,
  markWorkspaceSourceFailed,
  createWorkspaceFile,
  deleteWorkspaceFile,
  deleteFile,
  createGeneratedFile,
  renameGeneratedFile,
} from "@/lib/code-builder-api";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  Image,
  Settings,
  Package,
  GitBranch,
  Loader2,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  FolderUp,
  FileArchive,
  MoreVertical,
  X,
  AlertTriangle,
  CheckSquare,
  Square,
} from "lucide-react";

// ── File icon mapping ────────────────────────────────────────────────────

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const iconClass = "w-4 h-4 flex-shrink-0";

  switch (ext) {
    case "py":
      return <FileCode className={`${iconClass} text-yellow-400`} />;
    case "js":
    case "jsx":
      return <FileCode className={`${iconClass} text-yellow-300`} />;
    case "ts":
    case "tsx":
      return <FileCode className={`${iconClass} text-blue-400`} />;
    case "json":
      return <FileJson className={`${iconClass} text-yellow-500`} />;
    case "md":
    case "txt":
      return <FileText className={`${iconClass} text-gray-400`} />;
    case "html":
      return <FileCode className={`${iconClass} text-orange-400`} />;
    case "css":
    case "scss":
      return <FileCode className={`${iconClass} text-blue-300`} />;
    case "svg":
    case "png":
    case "jpg":
    case "gif":
      return <Image className={`${iconClass} text-green-400`} />;
    case "yaml":
    case "yml":
    case "toml":
      return <Settings className={`${iconClass} text-gray-400`} />;
    case "env":
      return <Settings className={`${iconClass} text-green-300`} />;
    default:
      if (name === "package.json" || name === "package-lock.json")
        return <Package className={`${iconClass} text-green-400`} />;
      return <File className={`${iconClass} text-gray-400`} />;
  }
}

// ── Inline Name Input ────────────────────────────────────────────────────

interface InlineInputProps {
  defaultValue?: string;
  placeholder?: string;
  icon: React.ReactNode;
  depth: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InlineInput({ defaultValue = "", placeholder, icon, depth, onSubmit, onCancel }: InlineInputProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (defaultValue) {
      // Select just the filename without extension for rename
      const dotIdx = defaultValue.lastIndexOf(".");
      inputRef.current?.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length);
    }
  }, [defaultValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && value.trim()) {
      onSubmit(value.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-1 py-[1px]"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="w-4 flex-shrink-0" />
      {icon}
      <input
        ref={inputRef}
        className="flex-1 h-5 bg-cbv2-input border border-cbv2-accent rounded px-1 text-[11px] text-cbv2-text outline-none font-mono min-w-0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (value.trim()) onSubmit(value.trim()); else onCancel(); }}
        placeholder={placeholder}
      />
    </div>
  );
}

// ── TreeNode ────────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: CBv2FileNode;
  depth: number;
  selectedPath: string | null;
  generatingFiles: string[];
  completedFiles?: string[];
  fileActions?: Record<string, string>;
  onFileClick: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, node: CBv2FileNode) => void;
  renamingPath?: string | null;
  onRenameSubmit?: (oldPath: string, newName: string) => void;
  onRenameCancel?: () => void;
  // For inline create inside a folder
  creatingIn?: string | null;
  creatingType?: "file" | "folder" | null;
  onCreateSubmit?: (parentPath: string, name: string) => void;
  onCreateCancel?: () => void;
  // Multi-select (workspace)
  multiSelected?: Set<string>;
  onMultiSelect?: (path: string) => void;
  // Inline hover X button (used by Repository Files section so users can
  // quickly remove a single pulled file without opening the context menu).
  onInlineRemove?: (node: CBv2FileNode) => void;
  inlineRemoveTitle?: string;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  generatingFiles,
  completedFiles = [],
  fileActions = {},
  onFileClick,
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  creatingIn,
  creatingType,
  onCreateSubmit,
  onCreateCancel,
  multiSelected,
  onMultiSelect,
  onInlineRemove,
  inlineRemoveTitle,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);

  const isFolder = node.type === "folder";
  const isSelected = selectedPath === node.path;
  const isGenerating = generatingFiles.includes(node.path);
  const isCompleted = !isFolder && completedFiles.includes(node.path);
  const fileAction = fileActions[node.path];
  const isRenaming = renamingPath === node.path;
  const isCreatingHere = creatingIn === node.path && isFolder;
  const isMultiSelected = multiSelected?.has(node.path) ?? false;

  // Auto-expand when creating inside this folder
  useEffect(() => {
    if (isCreatingHere && !expanded) setExpanded(true);
  }, [isCreatingHere, expanded]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.ctrlKey && onMultiSelect) {
      e.preventDefault();
      onMultiSelect(node.path);
      return;
    }
    if (isFolder) {
      setExpanded((prev) => !prev);
    } else {
      onFileClick(node.path);
    }
  }, [isFolder, node.path, onFileClick, onMultiSelect]);

  const handleRightClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e, node);
  }, [node, onContextMenu]);

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={node.name}
        depth={depth}
        icon={isFolder ? <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" /> : getFileIcon(node.name)}
        onSubmit={(newName) => onRenameSubmit?.(node.path, newName)}
        onCancel={() => onRenameCancel?.()}
      />
    );
  }

  return (
    <div>
      <div
        className={["group flex items-center gap-1 py-[2px] cursor-pointer text-[12px] font-mono hover:bg-cbv2-hover transition-colors duration-75", isMultiSelected ? "bg-cbv2-accent/15 text-cbv2-accent" : isSelected ? "bg-cbv2-accent/10 text-cbv2-accent font-medium" : isCompleted ? (fileAction === "create" ? "text-green-400" : fileAction === "delete" ? "text-red-400 line-through opacity-60" : "text-amber-400") : "text-cbv2-text", isGenerating ? "animate-pulse text-cbv2-accent" : "", isCompleted && !isGenerating ? (fileAction === "create" ? "border-l-2 border-green-400" : fileAction === "modify" ? "border-l-2 border-amber-400" : fileAction === "delete" ? "border-l-2 border-red-400" : "") : ""].filter(Boolean).join(" ")}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        title={node.path}
      >
        {isFolder ? (
          expanded ? (
            <ChevronDown className="w-4 h-4 flex-shrink-0 text-cbv2-text-dim" />
          ) : (
            <ChevronRight className="w-4 h-4 flex-shrink-0 text-cbv2-text-dim" />
          )
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {isFolder ? (
          expanded ? (
            <FolderOpen className="w-4 h-4 flex-shrink-0 text-yellow-500" />
          ) : (
            <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        <span className="truncate">{node.name}</span>

        {isCompleted && !isGenerating && (
          <span className={`ml-1 px-1 py-0 rounded text-[8px] font-bold uppercase leading-tight ${
            fileAction === "create" ? "bg-green-900/40 text-green-400" : fileAction === "delete" ? "bg-red-900/40 text-red-400" : "bg-amber-900/40 text-amber-400"
          }`}>{fileAction === "create" ? "NEW" : fileAction === "delete" ? "DEL" : "MOD"}</span>
        )}

        {!isFolder && node.size !== undefined && (
          <span className="ml-auto mr-2 text-[11px] text-cbv2-text-dim">
            {node.size > 1024
              ? `${(node.size / 1024).toFixed(1)}K`
              : `${node.size}B`}
          </span>
        )}

        {isGenerating && (
          <span className="ml-auto mr-2">
            <span className="inline-block w-2 h-2 rounded-full bg-cbv2-accent animate-ping" />
          </span>
        )}

        {/* Inline hover X (e.g. Remove from Repository Files) */}
        {onInlineRemove && !isGenerating && (
          <button
            type="button"
            className={`${
              !isFolder && node.size !== undefined ? "ml-1" : "ml-auto"
            } mr-2 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-900/40 hover:text-red-400 text-cbv2-text-dim transition-opacity`}
            title={inlineRemoveTitle ?? "Remove"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onInlineRemove(node);
            }}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {isFolder && expanded && (
        <div>
          {/* Inline create input at top of folder */}
          {isCreatingHere && creatingType && onCreateSubmit && onCreateCancel && (
            <InlineInput
              depth={depth + 1}
              placeholder={creatingType === "folder" ? "folder name" : "filename.ext"}
              icon={creatingType === "folder"
                ? <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
                : <File className="w-4 h-4 flex-shrink-0 text-gray-400" />
              }
              onSubmit={(name) => onCreateSubmit(node.path, name)}
              onCancel={onCreateCancel}
            />
          )}
          {node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              generatingFiles={generatingFiles}
              completedFiles={completedFiles}
              fileActions={fileActions}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              creatingIn={creatingIn}
              creatingType={creatingType}
              onCreateSubmit={onCreateSubmit}
              onCreateCancel={onCreateCancel}
              multiSelected={multiSelected}
              onMultiSelect={onMultiSelect}
              onInlineRemove={onInlineRemove}
              inlineRemoveTitle={inlineRemoveTitle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Explorer Sidebar ─────────────────────────────────────────────────────

interface CBv2ExplorerProps {
  projectId?: number | null;
  activeRunId?: string;
  activeOutputDir?: string;
  fileTree: CBv2FileNode[];
  fileCount: number;
  selectedPath: string | null;
  generatingFiles: string[];
  completedFiles?: string[];
  fileActions?: Record<string, string>;
  onFileClick: (path: string) => void;
  repoFileTree?: CBv2FileNode[];
  repoFileCount?: number;
  onRepoFileClick?: (path: string) => void;
  onOpenSourceControl?: () => void;
  onRepoFilesChanged?: () => void;
  // Workspace upload
  workspaceFileTree?: CBv2FileNode[];
  workspaceFileCount?: number;
  onWorkspaceFileClick?: (path: string) => void;
  analysisStatus?: CBv2WorkspaceAnalysisStatus | null;
  onUploadComplete?: () => void;
  workspaceSources?: CBv2WorkspaceSource[];
  onWorkspaceSourcesChanged?: () => void;
  pipelineType?: string;
  onGeneratedFilesChanged?: () => void;
}

export default function CBv2Explorer({
  projectId,
  activeRunId,
  activeOutputDir,
  fileTree,
  fileCount,
  selectedPath,
  generatingFiles,
  completedFiles = [],
  fileActions = {},
  onFileClick,
  repoFileTree,
  repoFileCount,
  onRepoFileClick,
  onOpenSourceControl,
  onRepoFilesChanged,
  workspaceFileTree,
  workspaceFileCount,
  onWorkspaceFileClick,
  analysisStatus,
  onUploadComplete,
  workspaceSources,
  onWorkspaceSourcesChanged,
  pipelineType,
  onGeneratedFilesChanged,
}: CBv2ExplorerProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showRepoFiles, setShowRepoFiles] = useState(true);
  const [showWorkspaceFiles, setShowWorkspaceFiles] = useState(true);
  const [scResult, setScResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Upload state
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // File management state
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; node: CBv2FileNode; section: "generated" | "repo" | "workspace" } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CBv2FileNode | null>(null);
  const [fileOpLoading, setFileOpLoading] = useState(false);

  // Generated files multi-select & delete
  const [selectedGenPaths, setSelectedGenPaths] = useState<Set<string>>(new Set());
  const [genDeleteConfirm, setGenDeleteConfirm] = useState<CBv2FileNode | null>(null);
  const [genBulkDeleteConfirm, setGenBulkDeleteConfirm] = useState(false);
  const [genFileOpLoading, setGenFileOpLoading] = useState(false);

  // Generated files create / rename (parallel to repo + workspace state)
  const [genCreatingIn, setGenCreatingIn] = useState<string | null>(null);
  const [genCreatingType, setGenCreatingType] = useState<"file" | "folder" | null>(null);
  const [genRenamingPath, setGenRenamingPath] = useState<string | null>(null);

  // Workspace source management
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);

  const handleDeleteSource = useCallback(async (runId: string) => {
    if (!projectId) return;
    setDeletingSourceId(runId);
    try {
      await deleteWorkspaceSource(projectId, runId);
      setScResult({ type: "success", message: "Workspace source removed" });
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Failed to remove source" });
    } finally {
      setDeletingSourceId(null);
      setTimeout(() => setScResult(null), 4000);
    }
  }, [projectId, onWorkspaceSourcesChanged]);

  const handleClearAllSources = useCallback(async () => {
    if (!projectId) return;
    try {
      await clearAllWorkspaceSources(projectId);
      setScResult({ type: "success", message: "All workspace sources cleared" });
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Failed to clear sources" });
    } finally {
      setTimeout(() => setScResult(null), 4000);
    }
  }, [projectId, onWorkspaceSourcesChanged]);

  // Pulled-repo bookkeeping: the git-pull workspace source (if any). Used to
  // (a) surface the analysis status on the Repository Files header, and
  // (b) provide a one-click "Remove all repository files" action that wipes
  // both the cloned dir AND the associated analysis_run row in one call.
  const gitPullSources = useMemo(
    () => (workspaceSources ?? []).filter((s) => s.source_type === "git_pull"),
    [workspaceSources],
  );
  const gitPullSource = gitPullSources[0];
  const onlyGitPullSources =
    (workspaceSources?.length ?? 0) > 0 &&
    gitPullSources.length === (workspaceSources?.length ?? 0);

  const handleRemoveRepositoryFiles = useCallback(async () => {
    if (!projectId) return;
    if (typeof window !== "undefined" && !window.confirm(
      "Remove all Repository Files from this explorer? The local clone and its analysis will be deleted (your remote git repo is not affected).",
    )) {
      return;
    }
    try {
      // If there's a corresponding git_pull workspace source, delete it
      // first so the analysis run + clone dir are cleaned up server-side.
      // Fallback to clearAll when no source row was registered yet.
      if (gitPullSource?.run_id) {
        await deleteWorkspaceSource(projectId, gitPullSource.run_id);
      } else {
        await clearAllWorkspaceSources(projectId);
      }
      setScResult({ type: "success", message: "Repository files removed" });
      onRepoFilesChanged?.();
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Failed to remove repository files" });
    } finally {
      setTimeout(() => setScResult(null), 4000);
    }
  }, [projectId, gitPullSource, onRepoFilesChanged, onWorkspaceSourcesChanged]);

  const handleMarkFailed = useCallback(async (runId: string) => {
    if (!projectId) return;
    try {
      await markWorkspaceSourceFailed(projectId, runId);
      setScResult({ type: "success", message: "Source marked as failed" });
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Failed to update source" });
    } finally {
      setTimeout(() => setScResult(null), 4000);
    }
  }, [projectId, onWorkspaceSourcesChanged]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setNodeContextMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setNodeContextMenu(null);
  }, []);

  // ── File management handlers (repo files) ──────────────────────────────

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: CBv2FileNode, section: "generated" | "repo" | "workspace") => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setNodeContextMenu({ x: e.clientX, y: e.clientY, node, section });
  }, []);

  const closeNodeContextMenu = useCallback(() => setNodeContextMenu(null), []);

  const handleCreateFile = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setCreatingIn(parentPath);
    setCreatingType("file");
  }, [closeNodeContextMenu]);

  const handleCreateFolder = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setCreatingIn(parentPath);
    setCreatingType("folder");
  }, [closeNodeContextMenu]);

  const handleRenameStart = useCallback((path: string) => {
    closeNodeContextMenu();
    setRenamingPath(path);
  }, [closeNodeContextMenu]);

  const handleDeleteStart = useCallback((node: CBv2FileNode) => {
    closeNodeContextMenu();
    setDeleteConfirm(node);
  }, [closeNodeContextMenu]);

  const handleCreateSubmit = useCallback(async (parentPath: string, name: string) => {
    if (!projectId || !creatingType) return;
    setFileOpLoading(true);
    try {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      await createGitRepoFile(projectId, fullPath, creatingType);
      onRepoFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Create failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setCreatingIn(null);
      setCreatingType(null);
    }
  }, [projectId, creatingType, onRepoFilesChanged]);

  const handleCreateCancel = useCallback(() => {
    setCreatingIn(null);
    setCreatingType(null);
  }, []);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    if (!projectId) return;
    setFileOpLoading(true);
    try {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      await renameGitRepoFile(projectId, oldPath, newPath);
      onRepoFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Rename failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setRenamingPath(null);
    }
  }, [projectId, onRepoFilesChanged]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!projectId || !deleteConfirm) return;
    setFileOpLoading(true);
    try {
      await deleteGitRepoFile(projectId, deleteConfirm.path);
      onRepoFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setDeleteConfirm(null);
    }
  }, [projectId, deleteConfirm, onRepoFilesChanged]);

  // For "New File" / "New Folder" at root level (repo section header)
  const handleCreateAtRoot = useCallback((type: "file" | "folder") => {
    closeContextMenu();
    setCreatingIn("");
    setCreatingType(type);
  }, [closeContextMenu]);

  // ── Workspace file management handlers ─────────────────────────────

  const [wsCreatingIn, setWsCreatingIn] = useState<string | null>(null);
  const [wsCreatingType, setWsCreatingType] = useState<"file" | "folder" | null>(null);
  const [wsDeleteConfirm, setWsDeleteConfirm] = useState<CBv2FileNode | null>(null);
  const [wsFileOpLoading, setWsFileOpLoading] = useState(false);

  // Workspace multi-select
  const [selectedWsPaths, setSelectedWsPaths] = useState<Set<string>>(new Set());
  const [wsBulkDeleteConfirm, setWsBulkDeleteConfirm] = useState(false);

  const handleWsCreateFile = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setWsCreatingIn(parentPath);
    setWsCreatingType("file");
  }, [closeNodeContextMenu]);

  const handleWsCreateFolder = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setWsCreatingIn(parentPath);
    setWsCreatingType("folder");
  }, [closeNodeContextMenu]);

  const handleWsDeleteStart = useCallback((node: CBv2FileNode) => {
    closeNodeContextMenu();
    setWsDeleteConfirm(node);
  }, [closeNodeContextMenu]);

  const handleWsCreateSubmit = useCallback(async (parentPath: string, name: string) => {
    if (!projectId || !wsCreatingType) return;
    setWsFileOpLoading(true);
    try {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      await createWorkspaceFile(projectId, fullPath, wsCreatingType);
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Create failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setWsFileOpLoading(false);
      setWsCreatingIn(null);
      setWsCreatingType(null);
    }
  }, [projectId, wsCreatingType, onWorkspaceSourcesChanged]);

  const handleWsCreateCancel = useCallback(() => {
    setWsCreatingIn(null);
    setWsCreatingType(null);
  }, []);

  const handleWsDeleteConfirm = useCallback(async () => {
    if (!projectId || !wsDeleteConfirm) return;
    setWsFileOpLoading(true);
    try {
      await deleteWorkspaceFile(projectId, wsDeleteConfirm.path);
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setWsFileOpLoading(false);
      setWsDeleteConfirm(null);
    }
  }, [projectId, wsDeleteConfirm, onWorkspaceSourcesChanged]);

  // Root-level create for workspace section
  const handleWsCreateAtRoot = useCallback((type: "file" | "folder") => {
    closeContextMenu();
    setWsCreatingIn("");
    setWsCreatingType(type);
  }, [closeContextMenu]);

  // ── Generated files multi-select & delete handlers ─────────────────

  const collectAllPaths = useCallback((nodes: CBv2FileNode[]): string[] => {
    const paths: string[] = [];
    function walk(node: CBv2FileNode) {
      paths.push(node.path);
      node.children?.forEach(walk);
    }
    nodes.forEach(walk);
    return paths;
  }, []);

  const handleGenToggleSelect = useCallback((path: string) => {
    setSelectedGenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleGenSelectAll = useCallback(() => {
    setSelectedGenPaths(new Set(collectAllPaths(fileTree)));
  }, [fileTree, collectAllPaths]);

  const handleGenDeselectAll = useCallback(() => {
    setSelectedGenPaths(new Set());
  }, []);

  const handleGenDeleteStart = useCallback((node: CBv2FileNode) => {
    closeNodeContextMenu();
    setGenDeleteConfirm(node);
  }, [closeNodeContextMenu]);

  const handleGenDeleteConfirm = useCallback(async () => {
    if (!genDeleteConfirm) return;
    setGenFileOpLoading(true);
    try {
      await deleteFile(genDeleteConfirm.path, activeRunId, activeOutputDir);
      onGeneratedFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setGenFileOpLoading(false);
      setGenDeleteConfirm(null);
    }
  }, [genDeleteConfirm, activeRunId, activeOutputDir, onGeneratedFilesChanged]);

  const handleGenBulkDeleteConfirm = useCallback(async () => {
    if (selectedGenPaths.size === 0) return;
    setGenFileOpLoading(true);
    try {
      // Sort deepest paths first so children are deleted before their parent
      // folder. Then skip any path whose ancestor folder was already deleted
      // in this same batch (rmtree removed it server-side) to avoid spurious
      // "Failed to delete" toasts caused by already-gone children.
      const sorted = [...selectedGenPaths].sort((a, b) => b.length - a.length);
      const deletedFolders: string[] = [];
      const errors: string[] = [];
      let attempted = 0;
      for (const p of sorted) {
        const coveredByParent = deletedFolders.some(
          (f) => p === f || p.startsWith(f.endsWith("/") ? f : f + "/"),
        );
        if (coveredByParent) continue;
        attempted += 1;
        try {
          await deleteFile(p, activeRunId, activeOutputDir);
          // Heuristic: a path without a file extension is almost certainly a folder.
          if (!/\.[A-Za-z0-9]+$/.test(p.split("/").pop() || "")) {
            deletedFolders.push(p);
          }
        } catch {
          errors.push(p);
        }
      }
      if (errors.length === 0) {
        setScResult({ type: "success", message: `Deleted ${sorted.length} items` });
      } else if (errors.length < attempted) {
        setScResult({ type: "success", message: `Deleted ${attempted - errors.length} items (${errors.length} failed)` });
      } else {
        setScResult({ type: "error", message: "Failed to delete selected items" });
      }
      onGeneratedFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Bulk delete failed" });
    } finally {
      setGenFileOpLoading(false);
      setGenBulkDeleteConfirm(false);
      setSelectedGenPaths(new Set());
      setTimeout(() => setScResult(null), 4000);
    }
  }, [selectedGenPaths, activeRunId, activeOutputDir, onGeneratedFilesChanged]);

  // ── Generated files: create / rename handlers ───────────────────────
  const handleGenCreateFile = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setGenCreatingIn(parentPath);
    setGenCreatingType("file");
  }, [closeNodeContextMenu]);

  const handleGenCreateFolder = useCallback((parentPath: string) => {
    closeNodeContextMenu();
    setGenCreatingIn(parentPath);
    setGenCreatingType("folder");
  }, [closeNodeContextMenu]);

  const handleGenCreateAtRoot = useCallback((type: "file" | "folder") => {
    closeContextMenu();
    setGenCreatingIn("");
    setGenCreatingType(type);
  }, [closeContextMenu]);

  const handleGenCreateCancel = useCallback(() => {
    setGenCreatingIn(null);
    setGenCreatingType(null);
  }, []);

  const handleGenCreateSubmit = useCallback(async (parentPath: string, name: string) => {
    if (!genCreatingType) return;
    setGenFileOpLoading(true);
    try {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      await createGeneratedFile(fullPath, genCreatingType, activeRunId, activeOutputDir);
      onGeneratedFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Create failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setGenFileOpLoading(false);
      setGenCreatingIn(null);
      setGenCreatingType(null);
    }
  }, [genCreatingType, activeRunId, activeOutputDir, onGeneratedFilesChanged]);

  const handleGenRenameStart = useCallback((path: string) => {
    closeNodeContextMenu();
    setGenRenamingPath(path);
  }, [closeNodeContextMenu]);

  const handleGenRenameCancel = useCallback(() => {
    setGenRenamingPath(null);
  }, []);

  const handleGenRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    setGenFileOpLoading(true);
    try {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      await renameGeneratedFile(oldPath, newPath, activeRunId, activeOutputDir);
      onGeneratedFilesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Rename failed" });
      setTimeout(() => setScResult(null), 4000);
    } finally {
      setGenFileOpLoading(false);
      setGenRenamingPath(null);
    }
  }, [activeRunId, activeOutputDir, onGeneratedFilesChanged]);

  // ── Workspace multi-select handlers ────────────────────────────────

  const collectAllWsPaths = useCallback((nodes: CBv2FileNode[]): string[] => {
    const paths: string[] = [];
    function walk(node: CBv2FileNode) {
      paths.push(node.path);
      node.children?.forEach(walk);
    }
    nodes.forEach(walk);
    return paths;
  }, []);

  const handleWsToggleSelect = useCallback((path: string) => {
    setSelectedWsPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleWsSelectAll = useCallback(() => {
    if (!workspaceFileTree) return;
    const all = collectAllWsPaths(workspaceFileTree);
    setSelectedWsPaths(new Set(all));
  }, [workspaceFileTree, collectAllWsPaths]);

  const handleWsDeselectAll = useCallback(() => {
    setSelectedWsPaths(new Set());
  }, []);

  const handleWsBulkDeleteConfirm = useCallback(async () => {
    if (!projectId || selectedWsPaths.size === 0) return;
    setWsFileOpLoading(true);
    try {
      // Delete shortest paths first (parent dirs before children)
      const sorted = [...selectedWsPaths].sort((a, b) => a.length - b.length);
      const errors: string[] = [];
      for (const p of sorted) {
        try {
          await deleteWorkspaceFile(projectId, p);
        } catch {
          errors.push(p);
        }
      }
      if (errors.length === 0) {
        setScResult({ type: "success", message: `Deleted ${sorted.length} items` });
      } else if (errors.length < sorted.length) {
        setScResult({ type: "success", message: `Deleted ${sorted.length - errors.length} items (${errors.length} already removed)` });
      } else {
        setScResult({ type: "error", message: "Failed to delete selected items" });
      }
      onWorkspaceSourcesChanged?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Bulk delete failed" });
    } finally {
      setWsFileOpLoading(false);
      setWsBulkDeleteConfirm(false);
      setSelectedWsPaths(new Set());
      setTimeout(() => setScResult(null), 4000);
    }
  }, [projectId, selectedWsPaths, onWorkspaceSourcesChanged]);

  // ── Upload handlers ──────────────────────────────────────────────────

  const handleUploadFile = useCallback(() => {
    setShowUploadMenu(false);
    fileInputRef.current?.click();
  }, []);

  const handleUploadZip = useCallback(() => {
    setShowUploadMenu(false);
    zipInputRef.current?.click();
  }, []);

  const handleUploadFolder = useCallback(() => {
    setShowUploadMenu(false);
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId) return;
    const file = files[0];
    const isZip = file.name.toLowerCase().endsWith(".zip");
    setUploading(true);
    try {
      const result = await uploadToWorkspace(projectId, file);
      // Backend auto-extracts .zip into a folder named after the archive
      // and returns file_count = number of entries inside the archive.
      const msg = isZip || result.source_type === "zip"
        ? `Extracted ${result.file_count} file${result.file_count === 1 ? "" : "s"} from ${result.source_name}.zip — analyzing...`
        : `Uploaded ${result.source_name} — analyzing...`;
      setScResult({ type: "success", message: msg });
      onUploadComplete?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setUploading(false);
      e.target.value = "";
      setTimeout(() => setScResult(null), 5000);
    }
  }, [projectId, onUploadComplete]);

  const handleFolderInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId) return;
    setUploading(true);
    try {
      // Derive folder name from the first file's webkitRelativePath
      const firstPath = files[0].webkitRelativePath || files[0].name;
      const folderName = firstPath.split("/")[0] || "folder";
      const result = await uploadFolderToWorkspace(projectId, files, folderName);
      setScResult({ type: "success", message: `Uploaded ${result.file_count} files — analyzing...` });
      onUploadComplete?.();
    } catch (err) {
      setScResult({ type: "error", message: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setUploading(false);
      e.target.value = "";
      setTimeout(() => setScResult(null), 5000);
    }
  }, [projectId, onUploadComplete]);

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text" onContextMenu={handleContextMenu}>
      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} />
      <input
        ref={zipInputRef}
        type="file"
        className="hidden"
        accept=".zip,application/zip,application/x-zip-compressed"
        onChange={handleFileInputChange}
      />
      <input ref={folderInputRef} type="file" className="hidden" onChange={handleFolderInputChange}
        {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} />

      {/* Generated: Bulk Delete Confirmation Dialog */}
      {genBulkDeleteConfirm && selectedGenPaths.size > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setGenBulkDeleteConfirm(false)}>
          <div className="w-[300px] bg-cbv2-sidebar border border-cbv2-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Delete Selected Items</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text">
                Are you sure you want to delete{" "}
                <span className="text-cbv2-accent font-medium">{selectedGenPaths.size} item{selectedGenPaths.size > 1 ? "s" : ""}</span>?
              </p>
              <p className="text-[10px] text-cbv2-text-dim mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button
                className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={() => setGenBulkDeleteConfirm(false)}
                disabled={genFileOpLoading}
              >
                Cancel
              </button>
              <button
                className="h-7 px-4 rounded bg-red-600 text-[11px] text-white hover:bg-red-500 disabled:opacity-40 transition-colors flex items-center gap-1.5"
                onClick={handleGenBulkDeleteConfirm}
                disabled={genFileOpLoading}
              >
                {genFileOpLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete {selectedGenPaths.size} item{selectedGenPaths.size > 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generated: Single Delete Confirmation Dialog */}
      {genDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setGenDeleteConfirm(null)}>
          <div className="w-[300px] bg-cbv2-sidebar border border-cbv2-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Confirm Delete</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text">
                Are you sure you want to delete{" "}
                <span className="text-cbv2-accent font-medium">{genDeleteConfirm.name}</span>
                {genDeleteConfirm.type === "folder" ? " and all its contents" : ""}?
              </p>
              <p className="text-[10px] text-cbv2-text-dim mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button
                className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={() => setGenDeleteConfirm(null)}
                disabled={genFileOpLoading}
              >
                Cancel
              </button>
              <button
                className="h-7 px-4 rounded bg-red-600 text-[11px] text-white hover:bg-red-500 disabled:opacity-40 transition-colors flex items-center gap-1.5"
                onClick={handleGenDeleteConfirm}
                disabled={genFileOpLoading}
              >
                {genFileOpLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {wsBulkDeleteConfirm && selectedWsPaths.size > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setWsBulkDeleteConfirm(false)}>
          <div className="w-[300px] bg-cbv2-sidebar border border-cbv2-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Delete Selected Items</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text">
                Are you sure you want to delete{" "}
                <span className="text-cbv2-accent font-medium">{selectedWsPaths.size} item{selectedWsPaths.size > 1 ? "s" : ""}</span>?
              </p>
              <p className="text-[10px] text-cbv2-text-dim mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button
                className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={() => setWsBulkDeleteConfirm(false)}
                disabled={wsFileOpLoading}
              >
                Cancel
              </button>
              <button
                className="h-7 px-4 rounded bg-red-600 text-[11px] text-white hover:bg-red-500 disabled:opacity-40 transition-colors flex items-center gap-1.5"
                onClick={handleWsBulkDeleteConfirm}
                disabled={wsFileOpLoading}
              >
                {wsFileOpLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete {selectedWsPaths.size} item{selectedWsPaths.size > 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {(deleteConfirm || wsDeleteConfirm) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setDeleteConfirm(null); setWsDeleteConfirm(null); }}>
          <div className="w-[300px] bg-cbv2-sidebar border border-cbv2-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Confirm Delete</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text">
                Are you sure you want to delete{" "}
                <span className="text-cbv2-accent font-medium">{(deleteConfirm || wsDeleteConfirm)!.name}</span>
                {(deleteConfirm || wsDeleteConfirm)!.type === "folder" ? " and all its contents" : ""}?
              </p>
              <p className="text-[10px] text-cbv2-text-dim mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button
                className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={() => { setDeleteConfirm(null); setWsDeleteConfirm(null); }}
                disabled={fileOpLoading || wsFileOpLoading}
              >
                Cancel
              </button>
              <button
                className="h-7 px-4 rounded bg-red-600 text-[11px] text-white hover:bg-red-500 disabled:opacity-40 transition-colors flex items-center gap-1.5"
                onClick={deleteConfirm ? handleDeleteConfirm : handleWsDeleteConfirm}
                disabled={fileOpLoading || wsFileOpLoading}
              >
                {(fileOpLoading || wsFileOpLoading) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Background Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
          <div
            className="fixed z-50 min-w-[180px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {repoFileTree && repoFileTree.length > 0 && projectId && (
              <>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => handleCreateAtRoot("file")}
                >
                  <FilePlus className="w-3.5 h-3.5" />
                  New File
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => handleCreateAtRoot("folder")}
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  New Folder
                </button>
                <div className="my-1 border-t border-cbv2-border" />
              </>
            )}
            {onOpenSourceControl && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={() => { closeContextMenu(); onOpenSourceControl(); }}
              >
                <GitBranch className="w-3.5 h-3.5" />
                Source Control
              </button>
            )}
          </div>
        </>
      )}

      {/* Node-level Context Menu (File actions) */}
      {nodeContextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeNodeContextMenu} />
          <div
            className="fixed z-50 min-w-[180px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md shadow-xl"
            style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
          >
            {nodeContextMenu.section === "repo" && (
              <>
                {nodeContextMenu.node.type === "folder" && (
                  <>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleCreateFile(nodeContextMenu.node.path)}
                    >
                      <FilePlus className="w-3.5 h-3.5" />
                      New File
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleCreateFolder(nodeContextMenu.node.path)}
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      New Folder
                    </button>
                    <div className="my-1 border-t border-cbv2-border" />
                  </>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => handleRenameStart(nodeContextMenu.node.path)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Rename
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors"
                  onClick={() => handleDeleteStart(nodeContextMenu.node)}
                >
                  <X className="w-3.5 h-3.5" />
                  Remove
                </button>
              </>
            )}
            {nodeContextMenu.section === "generated" && (
              <>
                {nodeContextMenu.node.type === "folder" && (
                  <>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleGenCreateFile(nodeContextMenu.node.path)}
                    >
                      <FilePlus className="w-3.5 h-3.5" />
                      New File
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleGenCreateFolder(nodeContextMenu.node.path)}
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      New Folder
                    </button>
                    <div className="my-1 border-t border-cbv2-border" />
                  </>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => handleGenRenameStart(nodeContextMenu.node.path)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Rename
                </button>
                <div className="my-1 border-t border-cbv2-border" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => { closeNodeContextMenu(); handleGenSelectAll(); }}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  Select All
                </button>
                {selectedGenPaths.size > 0 && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                    onClick={() => { closeNodeContextMenu(); handleGenDeselectAll(); }}
                  >
                    <Square className="w-3.5 h-3.5" />
                    Deselect All
                  </button>
                )}
                <div className="my-1 border-t border-cbv2-border" />
                {selectedGenPaths.size > 1 && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors"
                    onClick={() => { closeNodeContextMenu(); setGenBulkDeleteConfirm(true); }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Selected ({selectedGenPaths.size})
                  </button>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors"
                  onClick={() => handleGenDeleteStart(nodeContextMenu.node)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </>
            )}
            {nodeContextMenu.section === "workspace" && (
              <>
                {nodeContextMenu.node.type === "folder" && (
                  <>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleWsCreateFile(nodeContextMenu.node.path)}
                    >
                      <FilePlus className="w-3.5 h-3.5" />
                      New File
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={() => handleWsCreateFolder(nodeContextMenu.node.path)}
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      New Folder
                    </button>
                    <div className="my-1 border-t border-cbv2-border" />
                  </>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                  onClick={() => { closeNodeContextMenu(); handleWsSelectAll(); }}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  Select All
                </button>
                {selectedWsPaths.size > 0 && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                    onClick={() => { closeNodeContextMenu(); handleWsDeselectAll(); }}
                  >
                    <Square className="w-3.5 h-3.5" />
                    Deselect All
                  </button>
                )}
                <div className="my-1 border-t border-cbv2-border" />
                {selectedWsPaths.size > 1 && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors"
                    onClick={() => { closeNodeContextMenu(); setWsBulkDeleteConfirm(true); }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Selected ({selectedWsPaths.size})
                  </button>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors"
                  onClick={() => handleWsDeleteStart(nodeContextMenu.node)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Header */}
      <div className="px-4 py-2 text-[11px] font-sans uppercase tracking-wider text-cbv2-text-dim border-b border-cbv2-border flex items-center justify-between">
        <span>Explorer</span>
        <div className="flex items-center gap-1">
          {/* Upload Menu */}
          {projectId && (
            <div className="relative">
              <button
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-accent transition-colors"
                onClick={() => setShowUploadMenu((v) => !v)}
                title="Upload File or Folder"
                disabled={uploading}
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              </button>
              {showUploadMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowUploadMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md shadow-xl">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={handleUploadFile}
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Upload File
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={handleUploadZip}
                      title="Upload a .zip archive — it will be extracted automatically"
                    >
                      <FileArchive className="w-3.5 h-3.5 text-amber-400" />
                      Upload .zip Archive
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                      onClick={handleUploadFolder}
                    >
                      <FolderUp className="w-3.5 h-3.5" />
                      Upload Folder
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {projectId && repoFileTree && repoFileTree.length > 0 && (
            <>
              <button
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                onClick={() => handleCreateAtRoot("file")}
                title="New File"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                onClick={() => handleCreateAtRoot("folder")}
                title="New Folder"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {(fileCount > 0 || (repoFileCount ?? 0) > 0 || (workspaceFileCount ?? 0) > 0) && (
            <span className="text-cbv2-accent font-mono normal-case ml-1">
              {fileCount > 0
                ? fileCount + (repoFileCount ?? 0)
                : (repoFileCount ?? 0) + (workspaceFileCount ?? 0)}
            </span>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 cbv2-scrollbar">
        {/* ── Project files (unified view — generated + workspace) ────── */}
        {fileTree.length > 0 && (
          <div>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-cbv2-text-dim border-b border-cbv2-border/50 flex items-center gap-1">
              Project
              <span className="ml-1 text-cbv2-accent">{fileCount}</span>
              {completedFiles && completedFiles.length > 0 && (
                <span className="ml-2 flex items-center gap-1.5 text-[9px] font-mono">
                  {Object.values(fileActions).filter(a => a === "create").length > 0 && (
                    <span className="px-1 rounded bg-green-900/40 text-green-400">
                      +{Object.values(fileActions).filter(a => a === "create").length}
                    </span>
                  )}
                  {Object.values(fileActions).filter(a => a === "modify").length > 0 && (
                    <span className="px-1 rounded bg-amber-900/40 text-amber-400">
                      ~{Object.values(fileActions).filter(a => a === "modify").length}
                    </span>
                  )}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {selectedGenPaths.size > 0 && (
                  <span className="text-[9px] text-cbv2-accent font-mono mr-1">
                    {selectedGenPaths.size} selected
                  </span>
                )}
                <button
                  className="p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-text transition-colors"
                  onClick={(e) => { e.stopPropagation(); handleGenCreateAtRoot("file"); }}
                  title="New File"
                  disabled={genFileOpLoading}
                >
                  <FilePlus className="w-3.5 h-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-text transition-colors"
                  onClick={(e) => { e.stopPropagation(); handleGenCreateAtRoot("folder"); }}
                  title="New Folder"
                  disabled={genFileOpLoading}
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>
              </span>
            </div>
            {genCreatingIn === "" && genCreatingType && (
              <InlineInput
                depth={0}
                placeholder={genCreatingType === "folder" ? "folder name" : "filename.ext"}
                icon={genCreatingType === "folder"
                  ? <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
                  : <File className="w-4 h-4 flex-shrink-0 text-gray-400" />
                }
                onSubmit={(name) => handleGenCreateSubmit("", name)}
                onCancel={handleGenCreateCancel}
              />
            )}
            {fileTree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                generatingFiles={generatingFiles}
                completedFiles={completedFiles}
                fileActions={fileActions}
                onFileClick={onFileClick}
                onContextMenu={(e, n) => handleNodeContextMenu(e, n, "generated")}
                multiSelected={selectedGenPaths}
                onMultiSelect={handleGenToggleSelect}
                renamingPath={genRenamingPath}
                onRenameSubmit={handleGenRenameSubmit}
                onRenameCancel={handleGenRenameCancel}
                creatingIn={genCreatingIn}
                creatingType={genCreatingType}
                onCreateSubmit={handleGenCreateSubmit}
                onCreateCancel={handleGenCreateCancel}
              />
            ))}
          </div>
        )}

        {/* Repo files section */}
        {repoFileTree && repoFileTree.length > 0 && (
          <div>
            <div
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-cbv2-text-dim border-b border-cbv2-border/50 hover:bg-cbv2-hover transition-colors cursor-pointer"
              onClick={() => setShowRepoFiles((v) => !v)}
            >
              {showRepoFiles ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <GitBranch className="w-3 h-3" />
              Repository Files
              <span className="ml-1 text-cbv2-accent">{repoFileCount ?? 0}</span>
              {/* Analysis status badge (driven by the git-pull workspace source) */}
              {gitPullSource && (
                <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full ${
                  gitPullSource.analysis_status === "ready" ? "bg-green-900/40 text-green-300" :
                  gitPullSource.analysis_status === "failed" ? "bg-red-900/40 text-red-300" :
                  gitPullSource.analysis_status === "analyzing" || gitPullSource.analysis_status === "ingesting" ? "bg-yellow-900/40 text-yellow-300" :
                  "bg-blue-900/40 text-blue-300"
                }`}>
                  {gitPullSource.analysis_status === "analyzing" ? "Analyzing..." :
                   gitPullSource.analysis_status === "ingesting" ? "Ingesting..." :
                   gitPullSource.analysis_status === "pending" ? "Pending" :
                   gitPullSource.analysis_status === "failed" ? "Failed" :
                   gitPullSource.analysis_status === "ready" ? "Ready" : gitPullSource.analysis_status}
                </span>
              )}
              {/* Remove all repository files (local clone + analysis run) */}
              {projectId && (
                <button
                  className={`${gitPullSource ? "ml-0.5" : "ml-auto"} p-0.5 rounded hover:bg-red-900/30 text-cbv2-text-dim hover:text-red-400 transition-colors`}
                  onClick={(e) => { e.stopPropagation(); handleRemoveRepositoryFiles(); }}
                  title="Remove all repository files (local clone only)"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
            {showRepoFiles && (
              <>
                {/* Root-level inline create */}
                {creatingIn === "" && creatingType && (
                  <InlineInput
                    depth={0}
                    placeholder={creatingType === "folder" ? "folder name" : "filename.ext"}
                    icon={creatingType === "folder"
                      ? <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
                      : <File className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    }
                    onSubmit={(name) => handleCreateSubmit("", name)}
                    onCancel={handleCreateCancel}
                  />
                )}
                {repoFileTree.map((node) => (
                  <TreeNode
                    key={`repo-${node.path}`}
                    node={node}
                    depth={0}
                    selectedPath={selectedPath}
                    generatingFiles={[]}
                    onFileClick={onRepoFileClick || onFileClick}
                    onContextMenu={(e, n) => handleNodeContextMenu(e, n, "repo")}
                    renamingPath={renamingPath}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    creatingIn={creatingIn}
                    creatingType={creatingType}
                    onCreateSubmit={handleCreateSubmit}
                    onCreateCancel={handleCreateCancel}
                    onInlineRemove={handleDeleteStart}
                    inlineRemoveTitle="Remove from repository (locally)"
                  />
                ))}
              </>
            )}
          </div>
        )}

        {/* Workspace uploaded files section — only shown when no generated project exists,
            AND when there is at least one non-git-pull source. Git-pull sources are
            represented by the "Repository Files" section above (with their own status
            badge and remove button), so showing them here too would duplicate the entry. */}
        {fileTree.length === 0 && !onlyGitPullSources && ((workspaceFileTree && workspaceFileTree.length > 0) || (workspaceSources && workspaceSources.length > 0)) && (
          <div>
            <div
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-cbv2-text-dim border-b border-cbv2-border/50 hover:bg-cbv2-hover transition-colors cursor-pointer"
              onClick={() => setShowWorkspaceFiles((v) => !v)}
            >
              {showWorkspaceFiles ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <Upload className="w-3 h-3" />
              Workspace
              <span className="ml-1 text-cbv2-accent">{workspaceSources?.length ?? workspaceFileCount ?? 0}</span>
              {analysisStatus && analysisStatus.status !== "empty" && analysisStatus.status !== "ready" && (
                <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full ${
                  analysisStatus.status === "analyzing" || analysisStatus.status === "ingesting"
                    ? "bg-yellow-900/40 text-yellow-300"
                    : analysisStatus.status === "failed"
                    ? "bg-red-900/40 text-red-300"
                    : "bg-blue-900/40 text-blue-300"
                }`}>
                  {analysisStatus.status === "analyzing" ? "Analyzing..." :
                   analysisStatus.status === "ingesting" ? "Ingesting..." :
                   analysisStatus.status === "pending" ? "Pending" :
                   analysisStatus.status === "failed" ? "Failed" : ""}
                </span>
              )}
              {analysisStatus && analysisStatus.status === "ready" && (
                <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-300">
                  Ready
                </span>
              )}
              {/* Workspace action buttons */}
              {projectId && (
                <>
                  <button
                    className="ml-1 p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                    onClick={(e) => { e.stopPropagation(); handleWsCreateAtRoot("file"); }}
                    title="New File"
                  >
                    <FilePlus className="w-3 h-3" />
                  </button>
                  <button
                    className="ml-0.5 p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                    onClick={(e) => { e.stopPropagation(); handleWsCreateAtRoot("folder"); }}
                    title="New Folder"
                  >
                    <FolderPlus className="w-3 h-3" />
                  </button>
                  {selectedWsPaths.size > 0 && (
                    <span className="ml-0.5 text-[9px] text-cbv2-accent font-mono">
                      {selectedWsPaths.size} sel
                    </span>
                  )}
                </>
              )}
              {/* Clear all button */}
              {workspaceSources && workspaceSources.length > 0 && (
                <button
                  className="ml-0.5 p-0.5 rounded hover:bg-red-900/30 text-cbv2-text-dim hover:text-red-400 transition-colors"
                  onClick={(e) => { e.stopPropagation(); handleClearAllSources(); }}
                  title="Remove all workspace sources"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
            {showWorkspaceFiles && (
              <>
                {/* Source list with per-source status + delete */}
                {workspaceSources && workspaceSources.length > 0 && (
                  <div className="border-b border-cbv2-border/30">
                    {workspaceSources.map((source) => (
                      <div
                        key={source.run_id}
                        className="flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-cbv2-hover/50 group"
                      >
                        <Package className="w-3 h-3 text-cbv2-text-dim flex-shrink-0" />
                        <span className="text-cbv2-text truncate flex-1" title={source.source_name}>
                          {source.source_name}
                        </span>
                        <span className={`text-[9px] px-1 py-0.5 rounded ${
                          source.analysis_status === "ready" ? "bg-green-900/40 text-green-300" :
                          source.analysis_status === "failed" ? "bg-red-900/40 text-red-300" :
                          source.analysis_status === "analyzing" || source.analysis_status === "ingesting" ? "bg-yellow-900/40 text-yellow-300" :
                          "bg-blue-900/40 text-blue-300"
                        }`}>
                          {source.analysis_status}
                        </span>
                        {/* Mark stuck analysis as failed */}
                        {(source.analysis_status === "pending" || source.analysis_status === "analyzing" || source.analysis_status === "ingesting") && (
                          <button
                            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-orange-900/30 text-cbv2-text-dim hover:text-orange-400 transition-all"
                            onClick={() => handleMarkFailed(source.run_id)}
                            title="Mark as failed (unblock chat)"
                          >
                            <AlertTriangle className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-900/30 text-cbv2-text-dim hover:text-red-400 transition-all"
                          onClick={() => handleDeleteSource(source.run_id)}
                          disabled={deletingSourceId === source.run_id}
                          title={`Remove ${source.source_name}`}
                        >
                          {deletingSourceId === source.run_id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <X className="w-3 h-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* File tree */}
                {wsCreatingIn === "" && wsCreatingType && (
                  <InlineInput
                    depth={0}
                    placeholder={wsCreatingType === "folder" ? "folder name" : "filename.ext"}
                    icon={wsCreatingType === "folder"
                      ? <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
                      : <File className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    }
                    onSubmit={(name) => handleWsCreateSubmit("", name)}
                    onCancel={handleWsCreateCancel}
                  />
                )}
                {workspaceFileTree && workspaceFileTree.map((node) => (
                  <TreeNode
                    key={`ws-${node.path}`}
                    node={node}
                    depth={0}
                    selectedPath={selectedPath}
                    generatingFiles={[]}
                    onFileClick={onWorkspaceFileClick || onFileClick}
                    onContextMenu={(e, n) => handleNodeContextMenu(e, n, "workspace")}
                    creatingIn={wsCreatingIn}
                    creatingType={wsCreatingType}
                    onCreateSubmit={handleWsCreateSubmit}
                    onCreateCancel={handleWsCreateCancel}
                    multiSelected={selectedWsPaths}
                    onMultiSelect={handleWsToggleSelect}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {/* Empty state */}
        {fileTree.length === 0 && (!repoFileTree || repoFileTree.length === 0) && (!workspaceFileTree || workspaceFileTree.length === 0) && (
          <div className="px-4 py-8 text-center text-cbv2-text-dim text-[12px]">
            <Folder className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No files yet</p>
            <p className="text-[11px] mt-1">
              <span className="block mb-2">
                Describe your app in the chat to generate code, or upload
                existing files — <code className="px-1 rounded bg-cbv2-input text-amber-400">.zip</code> archives are extracted automatically.
              </span>
              {projectId && (
                <span className="inline-flex items-center gap-2 mt-1">
                  <button
                    className="inline-flex items-center gap-1 text-cbv2-accent hover:underline"
                    onClick={handleUploadFile}
                  >
                    <Upload className="w-3 h-3" /> Upload file
                  </button>
                  <span className="text-cbv2-text-dim">·</span>
                  <button
                    className="inline-flex items-center gap-1 text-cbv2-accent hover:underline"
                    onClick={handleUploadZip}
                  >
                    <FileArchive className="w-3 h-3" /> Upload .zip
                  </button>
                  <span className="text-cbv2-text-dim">·</span>
                  <button
                    className="inline-flex items-center gap-1 text-cbv2-accent hover:underline"
                    onClick={handleUploadFolder}
                  >
                    <FolderUp className="w-3 h-3" /> Upload folder
                  </button>
                </span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Analysis Status Bar — live progress */}
      {analysisStatus && (analysisStatus.status === "analyzing" || analysisStatus.status === "ingesting" || analysisStatus.status === "pending") && (
        <div className="px-3 py-2 bg-yellow-950/30 border-t border-yellow-800/50 text-[11px] text-yellow-300">
          <div className="flex items-center gap-2 mb-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {analysisStatus.status === "pending" ? "Preparing analysis..." :
               analysisStatus.status === "analyzing" ? "Analyzing uploaded code..." :
               "Ingesting into knowledge base..."}
            </span>
          </div>
          {analysisStatus.progress_detail && (
            <div className="text-[10px] text-yellow-400/80 mb-1 truncate" title={analysisStatus.progress_detail}>
              {analysisStatus.progress_detail}
            </div>
          )}
          <div className="w-full bg-yellow-900/40 rounded-full h-1.5">
            <div
              className="bg-yellow-400 h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${analysisStatus.total > 0
                  ? ((analysisStatus.ready / analysisStatus.total) * 100)
                  : (analysisStatus.status === "pending" ? 10 : analysisStatus.status === "analyzing" ? 40 : 70)}%`,
              }}
            />
          </div>
          <div className="text-[10px] text-yellow-400/70 mt-0.5">
            {analysisStatus.total > 0
              ? `${analysisStatus.ready} of ${analysisStatus.total} sources processed`
              : analysisStatus.status === "pending" ? "Queued..."
              : "Processing..."}
          </div>
        </div>
      )}

      {analysisStatus && analysisStatus.status === "ready" && analysisStatus.total > 0 && (
        <div className="px-3 py-1.5 bg-green-950/30 border-t border-green-800/50 text-[11px] text-green-300 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
          Analysis complete — ready to chat
        </div>
      )}

      {/* Status Bar */}
      {generatingFiles.length > 0 && (
        <div className="px-3 py-1.5 bg-cbv2-accent/10 border-t border-cbv2-border text-[11px] text-cbv2-accent flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-cbv2-accent animate-pulse" />
          Generating {generatingFiles.length} file
          {generatingFiles.length > 1 ? "s" : ""}...
        </div>
      )}

      {/* File operation result toast */}
      {scResult && (
        <div
          className={`px-3 py-1.5 border-t border-cbv2-border text-[11px] flex items-center gap-2 shrink-0 ${
            scResult.type === "success"
              ? "bg-green-950/30 text-green-300 border-green-800/50"
              : "bg-red-950/30 text-red-300 border-red-800/50"
          }`}
        >
          <span className="truncate">{scResult.message}</span>
        </div>
      )}
    </div>
  );
}
