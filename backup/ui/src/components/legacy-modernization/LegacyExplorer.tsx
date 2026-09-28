"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CBv2FileNode } from "@/types/code-builder-v2";
import {
  createGitRepoFile,
  deleteGitRepoFile,
  renameGitRepoFile,
} from "@/lib/legacy-modernization-api";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  Package,
  Pencil,
  Settings,
  Trash2,
} from "lucide-react";

type LegacyExplorerView = "source" | "target";

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
    case "mmd":
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
      return <ImageIcon className={`${iconClass} text-green-400`} />;
    case "yaml":
    case "yml":
    case "toml":
      return <Settings className={`${iconClass} text-gray-400`} />;
    case "env":
      return <Settings className={`${iconClass} text-green-300`} />;
    default:
      if (name === "package.json" || name === "package-lock.json") {
        return <Package className={`${iconClass} text-green-400`} />;
      }
      return <File className={`${iconClass} text-gray-400`} />;
  }
}

function countFiles(nodes: CBv2FileNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      total += 1;
    } else if (node.children?.length) {
      total += countFiles(node.children);
    }
  }
  return total;
}

// ── Inline Name Input (for create / rename) ──────────────────────────────

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

interface TreeNodeProps {
  node: CBv2FileNode;
  depth: number;
  selectedPath: string | null;
  generatingFiles: string[];
  onFileClick: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, node: CBv2FileNode) => void;
  renamingPath?: string | null;
  onRenameSubmit?: (oldPath: string, newName: string) => void;
  onRenameCancel?: () => void;
  creatingIn?: string | null;
  creatingType?: "file" | "folder" | null;
  onCreateSubmit?: (parentPath: string, name: string) => void;
  onCreateCancel?: () => void;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  generatingFiles,
  onFileClick,
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  creatingIn,
  creatingType,
  onCreateSubmit,
  onCreateCancel,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);

  const isFolder = node.type === "folder";
  const isSelected = selectedPath === node.path;
  const isGenerating = generatingFiles.includes(node.path);
  const isRenaming = renamingPath === node.path;
  const isCreatingHere = creatingIn === node.path && isFolder;

  const isExpanded = expanded || isCreatingHere;

  const handleClick = useCallback(() => {
    if (isFolder) {
      setExpanded((value) => !value);
    } else {
      onFileClick(node.path);
    }
  }, [isFolder, node.path, onFileClick]);

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
        className={[
          "flex items-center gap-1 py-[2px] cursor-pointer text-[12px] font-mono hover:bg-cbv2-hover transition-colors duration-75",
          isSelected ? "bg-cbv2-accent/10 text-cbv2-accent font-medium" : "text-cbv2-text",
          isGenerating ? "animate-pulse text-cbv2-accent" : "",
        ].filter(Boolean).join(" ")}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        title={node.path}
      >
        {isFolder ? (
          isExpanded ? (
            <ChevronDown className="w-4 h-4 flex-shrink-0 text-cbv2-text-dim" />
          ) : (
            <ChevronRight className="w-4 h-4 flex-shrink-0 text-cbv2-text-dim" />
          )
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {isFolder ? (
          isExpanded ? (
            <FolderOpen className="w-4 h-4 flex-shrink-0 text-yellow-500" />
          ) : (
            <Folder className="w-4 h-4 flex-shrink-0 text-yellow-600" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        <span className="truncate">{node.name}</span>

        {isFolder && !isExpanded && node.children && node.children.length > 0 && (
          <span className="ml-1 text-[9px] px-1.5 py-px rounded-full bg-cbv2-input text-cbv2-text-dim font-sans tabular-nums">
            {countFiles(node.children)}
          </span>
        )}

        {!isFolder && node.size !== undefined && (
          <span className="ml-auto mr-2 text-[11px] text-cbv2-text-dim">
            {node.size > 1024 ? `${(node.size / 1024).toFixed(1)}K` : `${node.size}B`}
          </span>
        )}

        {isGenerating && (
          <span className="ml-auto mr-2">
            <span className="inline-block w-2 h-2 rounded-full bg-cbv2-accent animate-ping" />
          </span>
        )}
      </div>

      {isFolder && isExpanded && node.children && (
        <div>
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
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              generatingFiles={generatingFiles}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              creatingIn={creatingIn}
              creatingType={creatingType}
              onCreateSubmit={onCreateSubmit}
              onCreateCancel={onCreateCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface LegacyExplorerProps {
  projectId?: number | null;
  fileTree: CBv2FileNode[];
  selectedPath: string | null;
  generatingFiles: string[];
  onFileClick: (path: string) => void;
  repoFileTree?: CBv2FileNode[];
  repoFileCount?: number;
  repoFilesReadOnly?: boolean;
  repoSectionLabel?: string;
  onRepoFileClick?: (path: string) => void;
  onOpenSourceControl?: () => void;
  onRepoFilesChanged?: () => void;
}

export default function LegacyExplorer({
  projectId,
  fileTree,
  selectedPath,
  generatingFiles,
  onFileClick,
  repoFileTree = [],
  repoFileCount = 0,
  repoFilesReadOnly = false,
  repoSectionLabel = "Git Repo Files",
  onRepoFileClick,
  onOpenSourceControl,
  onRepoFilesChanged,
}: LegacyExplorerProps) {
  const [view, setView] = useState<LegacyExplorerView>("source");
  const [showRepoFiles, setShowRepoFiles] = useState(true);

  // ── File CRUD state ──────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; node: CBv2FileNode; section: "generated" | "repo" } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CBv2FileNode | null>(null);
  const [fileOpLoading, setFileOpLoading] = useState(false);
  const [opResult, setOpResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setNodeContextMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const closeContextMenu = useCallback(() => { setContextMenu(null); setNodeContextMenu(null); }, []);

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: CBv2FileNode, section: "generated" | "repo") => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setNodeContextMenu({ x: e.clientX, y: e.clientY, node, section });
  }, []);
  const closeNodeContextMenu = useCallback(() => setNodeContextMenu(null), []);

  const handleCreateFile = useCallback((parentPath: string) => { closeNodeContextMenu(); setCreatingIn(parentPath); setCreatingType("file"); }, [closeNodeContextMenu]);
  const handleCreateFolder = useCallback((parentPath: string) => { closeNodeContextMenu(); setCreatingIn(parentPath); setCreatingType("folder"); }, [closeNodeContextMenu]);
  const handleRenameStart = useCallback((path: string) => { closeNodeContextMenu(); setRenamingPath(path); }, [closeNodeContextMenu]);
  const handleDeleteStart = useCallback((node: CBv2FileNode) => { closeNodeContextMenu(); setDeleteConfirm(node); }, [closeNodeContextMenu]);

  const handleCreateSubmit = useCallback(async (parentPath: string, name: string) => {
    if (!projectId || !creatingType) return;
    setFileOpLoading(true);
    try {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      await createGitRepoFile(projectId, fullPath, creatingType);
      onRepoFilesChanged?.();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Create failed" });
      setTimeout(() => setOpResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setCreatingIn(null);
      setCreatingType(null);
    }
  }, [projectId, creatingType, onRepoFilesChanged]);

  const handleCreateCancel = useCallback(() => { setCreatingIn(null); setCreatingType(null); }, []);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    if (!projectId) return;
    setFileOpLoading(true);
    try {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      await renameGitRepoFile(projectId, oldPath, newPath);
      onRepoFilesChanged?.();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Rename failed" });
      setTimeout(() => setOpResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setRenamingPath(null);
    }
  }, [projectId, onRepoFilesChanged]);

  const handleRenameCancel = useCallback(() => { setRenamingPath(null); }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!projectId || !deleteConfirm) return;
    setFileOpLoading(true);
    try {
      await deleteGitRepoFile(projectId, deleteConfirm.path);
      onRepoFilesChanged?.();
    } catch (err) {
      setOpResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setTimeout(() => setOpResult(null), 4000);
    } finally {
      setFileOpLoading(false);
      setDeleteConfirm(null);
    }
  }, [projectId, deleteConfirm, onRepoFilesChanged]);

  const handleCreateAtRoot = useCallback((type: "file" | "folder") => {
    closeContextMenu();
    setCreatingIn("");
    setCreatingType(type);
  }, [closeContextMenu]);

  const filteredTree = useMemo(() => {
    const sourceFolderNames = new Set(["src", "source"]);
    const targetFolderNames = new Set(["gen", "generated", "target"]);
    const analysisFolderNames = new Set(["ana", "analysis"]);

    const sourceNodes = fileTree.filter((node) =>
      sourceFolderNames.has(node.name.toLowerCase())
    );
    const targetNodes = fileTree.filter((node) =>
      targetFolderNames.has(node.name.toLowerCase())
    );
    const analysisNodes = fileTree.filter((node) =>
      analysisFolderNames.has(node.name.toLowerCase())
    );

    if (
      sourceNodes.length === 0 &&
      targetNodes.length === 0 &&
      analysisNodes.length === 0
    ) {
      return fileTree;
    }

    const primaryNodes = view === "source" ? sourceNodes : targetNodes;
    return [...primaryNodes, ...analysisNodes];
  }, [fileTree, view]);

  const fileCount = useMemo(() => countFiles(filteredTree), [filteredTree]);

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text" onContextMenu={handleContextMenu}>
      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)}>
          <div className="w-[300px] bg-cbv2-sidebar border border-cbv2-border rounded-lg cbv2-card-elevated cbv2-animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cbv2-border">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-[12px] font-semibold text-cbv2-text">Confirm Delete</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-cbv2-text">
                Are you sure you want to delete{" "}
                <span className="text-cbv2-accent font-medium">{deleteConfirm.name}</span>
                {deleteConfirm.type === "folder" ? " and all its contents" : ""}?
              </p>
              <p className="text-[10px] text-cbv2-text-dim mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cbv2-border">
              <button className="h-7 px-3 rounded border border-cbv2-border text-[11px] text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => setDeleteConfirm(null)} disabled={fileOpLoading}>Cancel</button>
              <button className="h-7 px-4 rounded bg-red-600 text-[11px] text-white hover:bg-red-500 disabled:opacity-40 transition-colors flex items-center gap-1.5" onClick={handleDeleteConfirm} disabled={fileOpLoading}>
                {fileOpLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
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
          <div className="fixed z-50 min-w-[180px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md cbv2-card-elevated cbv2-animate-scale-in" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {repoFileTree.length > 0 && projectId && !repoFilesReadOnly && (
              <>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => handleCreateAtRoot("file")}>
                  <FilePlus className="w-3.5 h-3.5" /> New File
                </button>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => handleCreateAtRoot("folder")}>
                  <FolderPlus className="w-3.5 h-3.5" /> New Folder
                </button>
                <div className="my-1 border-t border-cbv2-border" />
              </>
            )}
            {onOpenSourceControl && (
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { closeContextMenu(); onOpenSourceControl(); }}>
                <GitBranch className="w-3.5 h-3.5" /> Source Control
              </button>
            )}
          </div>
        </>
      )}

      {/* Node-level Context Menu */}
      {nodeContextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeNodeContextMenu} />
          <div className="fixed z-50 min-w-[180px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md cbv2-card-elevated cbv2-animate-scale-in" style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}>
            {nodeContextMenu.section === "repo" && !repoFilesReadOnly && (
              <>
                {nodeContextMenu.node.type === "folder" && (
                  <>
                    <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => handleCreateFile(nodeContextMenu.node.path)}>
                      <FilePlus className="w-3.5 h-3.5" /> New File
                    </button>
                    <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => handleCreateFolder(nodeContextMenu.node.path)}>
                      <FolderPlus className="w-3.5 h-3.5" /> New Folder
                    </button>
                    <div className="my-1 border-t border-cbv2-border" />
                  </>
                )}
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => handleRenameStart(nodeContextMenu.node.path)}>
                  <Pencil className="w-3.5 h-3.5" /> Rename
                </button>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-950/30 transition-colors" onClick={() => handleDeleteStart(nodeContextMenu.node)}>
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              </>
            )}
            {nodeContextMenu.section === "repo" && repoFilesReadOnly && (
              <div className="px-3 py-1.5 text-[11px] text-cbv2-text-dim">
                Previewed repo files are read-only until you pull the repository
              </div>
            )}
            {nodeContextMenu.section === "generated" && (
              <div className="px-3 py-1.5 text-[11px] text-cbv2-text-dim">
                Generated files are read-only
              </div>
            )}
          </div>
        </>
      )}

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-cbv2-border bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-cbv2-text-dim">Explorer</span>
          <div className="flex items-center gap-1">
            {fileCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent font-mono font-medium">
                {fileCount}
              </span>
            )}
            {projectId && repoFileTree.length > 0 && !repoFilesReadOnly && (
              <>
                <button
                  className="p-1 rounded-md hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                  onClick={() => handleCreateAtRoot("file")}
                  title="New File"
                >
                  <FilePlus className="w-3.5 h-3.5" />
                </button>
                <button
                  className="p-1 rounded-md hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                  onClick={() => handleCreateAtRoot("folder")}
                  title="New Folder"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
        {/* Segmented toggle */}
        <div className="flex items-center bg-cbv2-input rounded-lg p-0.5 border border-cbv2-border/50">
          <button
            className={[
              "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all duration-200",
              view === "source"
                ? "bg-cbv2-accent/15 text-cbv2-accent shadow-sm ring-1 ring-cbv2-accent/30"
                : "text-cbv2-text-dim hover:text-cbv2-text",
            ].join(" ")}
            onClick={() => setView("source")}
            title="Show legacy source files and analysis files"
          >
            <Folder className="w-3 h-3" />
            Source
          </button>
          <button
            className={[
              "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all duration-200",
              view === "target"
                ? "bg-green-500/15 text-green-400 shadow-sm ring-1 ring-green-500/30"
                : "text-cbv2-text-dim hover:text-cbv2-text",
            ].join(" ")}
            onClick={() => setView("target")}
            title="Show generated target files and analysis files"
          >
            <FileCode className="w-3 h-3" />
            Target
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 cbv2-scrollbar">
        {filteredTree.length === 0 && repoFileTree.length === 0 ? (
          <div className="px-4 py-10 text-center text-cbv2-text-dim">
            <div className="w-12 h-12 rounded-2xl bg-cbv2-input flex items-center justify-center mx-auto mb-3">
              <Folder className="w-6 h-6 opacity-40" />
            </div>
            <p className="text-[12px] font-medium text-cbv2-text">No files yet</p>
            <p className="text-[10px] mt-1">
              Start a generation to see files here
            </p>
          </div>
        ) : (
          <>
            {filteredTree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                generatingFiles={generatingFiles}
                onFileClick={onFileClick}
                onContextMenu={(e, n) => handleNodeContextMenu(e, n, "generated")}
              />
            ))}

            {repoFileTree.length > 0 && (
              <div className="border-t border-cbv2-border mt-1">
                <button
                  className="w-full flex items-center gap-2 px-4 py-2 text-[11px] font-sans uppercase tracking-wider text-cbv2-text-dim hover:bg-cbv2-hover transition-colors"
                  onClick={() => setShowRepoFiles((v) => !v)}
                >
                  {showRepoFiles ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  <span>{repoSectionLabel}</span>
                  <span className="text-cbv2-accent font-mono normal-case ml-auto">
                    {repoFileCount}
                  </span>
                  {repoFilesReadOnly && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-cbv2-input text-cbv2-text-dim normal-case">
                      preview
                    </span>
                  )}
                </button>
                {showRepoFiles && (
                  <div>
                    {/* Root-level inline create */}
                    {creatingIn === "" && creatingType && !repoFilesReadOnly && (
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
                        selectedPath={
                          selectedPath?.startsWith("repo:")
                            ? selectedPath.slice(5)
                            : selectedPath?.startsWith("repo-preview:")
                              ? selectedPath.slice(13)
                            : null
                        }
                        generatingFiles={[]}
                        onFileClick={onRepoFileClick || onFileClick}
                        onContextMenu={(e, n) => handleNodeContextMenu(e, n, "repo")}
                        renamingPath={repoFilesReadOnly ? null : renamingPath}
                        onRenameSubmit={repoFilesReadOnly ? undefined : handleRenameSubmit}
                        onRenameCancel={repoFilesReadOnly ? undefined : handleRenameCancel}
                        creatingIn={repoFilesReadOnly ? null : creatingIn}
                        creatingType={repoFilesReadOnly ? null : creatingType}
                        onCreateSubmit={repoFilesReadOnly ? undefined : handleCreateSubmit}
                        onCreateCancel={repoFilesReadOnly ? undefined : handleCreateCancel}
                      />
                    ))}
                    {onOpenSourceControl && (
                      <button
                        className="w-full px-4 py-1.5 text-[10px] text-cbv2-text-dim hover:text-cbv2-accent hover:bg-cbv2-hover transition-colors text-left"
                        onClick={onOpenSourceControl}
                      >
                        Open Source Control...
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {generatingFiles.length > 0 && (
        <div className="px-3 py-2 bg-gradient-to-r from-cbv2-accent/10 to-cbv2-accent/5 border-t border-cbv2-accent/20 text-[11px] text-cbv2-accent flex items-center gap-2">
          <div className="relative">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          </div>
          <span className="font-medium">Generating {generatingFiles.length} file
          {generatingFiles.length > 1 ? "s" : ""}...</span>
        </div>
      )}

      {/* File operation result toast */}
      {opResult && (
        <div
          className={`px-3 py-1.5 border-t border-cbv2-border text-[11px] flex items-center gap-2 shrink-0 ${
            opResult.type === "success"
              ? "bg-green-950/30 text-green-300 border-green-800/50"
              : "bg-red-950/30 text-red-300 border-red-800/50"
          }`}
        >
          <span className="truncate">{opResult.message}</span>
        </div>
      )}
    </div>
  );
}
