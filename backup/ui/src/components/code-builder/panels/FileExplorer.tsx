"use client";

import { useState, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileText,
  Search,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Plus,
  Upload,
  Package,
  Download,
  FolderArchive,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useCodeBuilderStore";
import { readFile, readOutputFile, downloadPipelineOutput, extractOutputToProject } from "@/lib/code-builder-api";
import { useFileTree, useOutputTree } from "@/hooks/useCodeBuilderQueries";
import queryKeys from "@/lib/query-keys";
import type { FileNode } from "@/types/code-builder";

/* ── Icon mapping ──────────────────────────────────────── */
function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = ["ts", "tsx", "js", "jsx", "py", "java", "go", "rs", "c", "cpp", "cs", "rb", "swift", "kt"];
  const jsonExts = ["json", "yaml", "yml", "toml"];
  const textExts = ["md", "txt", "log", "csv", "env"];
  if (codeExts.includes(ext)) return <FileCode size={14} className="text-editor-info shrink-0" />;
  if (jsonExts.includes(ext)) return <FileJson size={14} className="text-editor-warning shrink-0" />;
  if (textExts.includes(ext)) return <FileText size={14} className="text-editor-success shrink-0" />;
  return <File size={14} className="text-editor-sidebarFg shrink-0" />;
}

/* ── Tree node ─────────────────────────────────────────── */
function TreeNode({ node, depth, source, runId }: { node: FileNode; depth: number; source: "project" | "output"; runId?: string | null }) {
  const { selectedFile, selectFile, expandedDirs, toggleDir, openTab, currentProject } = useStore();

  const isDir = node.type === "directory";
  const isOpen = expandedDirs.has(node.path);
  const isSelected = selectedFile === node.path;

  const handleClick = useCallback(async () => {
    if (isDir) {
      toggleDir(node.path);
    } else {
      selectFile(node.path);
      try {
        let data: { content: string; language: string };
        if (source === "output" && runId) {
          data = await readOutputFile(runId, node.path);
        } else {
          const projectId = currentProject?.project_id;
          if (!projectId) return;
          data = await readFile(projectId, node.path);
        }
        openTab({
          path: node.path,
          name: node.name,
          language: data.language || "plaintext",
          content: data.content,
          isDirty: false,
          source,
          runId: runId ?? undefined,
        });
      } catch {
        openTab({
          path: node.path,
          name: node.name,
          language: node.language || "plaintext",
          content: "",
          isDirty: false,
          source,
        });
      }
    }
  }, [isDir, node, source, runId, toggleDir, selectFile, openTab, currentProject]);

  return (
    <>
      <button
        onClick={handleClick}
        className={`
          flex items-center gap-1 w-full text-left px-2 py-[3px] text-[12px]
          hover:bg-editor-active transition-colors duration-75 group
          ${isSelected ? "bg-editor-highlight text-white" : "text-editor-sidebarFg"}
        `}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={node.path}
      >
        {isDir ? (
          isOpen ? <ChevronDown size={12} className="shrink-0 opacity-70" />
                 : <ChevronRight size={12} className="shrink-0 opacity-70" />
        ) : (
          <span className="w-[12px] shrink-0" />
        )}
        {isDir ? (
          isOpen ? <FolderOpen size={14} className="text-editor-warning shrink-0" />
                 : <Folder size={14} className="text-editor-warning shrink-0" />
        ) : (
          fileIcon(node.name)
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {isDir && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} source={source} runId={runId} />
          ))}
        </div>
      )}
    </>
  );
}

/* ── FileExplorer (project files) ──────────────────────── */
export default function FileExplorer() {
  const { currentProject } = useStore();
  const [searchQuery, setSearchQuery] = useState("");
  const fileTreeQuery = useFileTree(currentProject?.project_id ?? null);
  const fileTree = fileTreeQuery.data ?? [];
  const isLoading = fileTreeQuery.isLoading;

  const filterTree = useCallback(
    (nodes: FileNode[], q: string): FileNode[] => {
      if (!q) return nodes;
      const lower = q.toLowerCase();
      return nodes.reduce<FileNode[]>((acc, node) => {
        if (node.type === "directory") {
          const filtered = filterTree(node.children ?? [], q);
          if (filtered.length > 0) acc.push({ ...node, children: filtered });
        } else if (node.name.toLowerCase().includes(lower)) {
          acc.push(node);
        }
        return acc;
      }, []);
    },
    []
  );

  const displayTree = filterTree(fileTree ?? [], searchQuery) ?? [];

  return (
    <div className="h-full flex flex-col">
      {/* header */}
      <div className="panel-header">
        <span>Explorer</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => fileTreeQuery.refetch()}
            className="p-1 rounded hover:bg-editor-active transition-colors" title="Refresh">
            <RefreshCw size={12} className={fileTreeQuery.isFetching ? "animate-spin" : ""} />
          </button>
          <button className="p-1 rounded hover:bg-editor-active transition-colors" title="New File">
            <Plus size={12} />
          </button>
        </div>
      </div>

      {/* search */}
      <div className="px-2 py-1 border-b border-editor-border">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text" placeholder="Search files…" value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-field pl-6 py-0.5 text-[11px]"
          />
        </div>
      </div>

      {/* tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!currentProject ? (
          <div className="px-3 py-6 text-center text-[11px] text-gray-500">
            <p className="mb-1">No project open</p>
            <p className="opacity-60">Create a project to explore files</p>
          </div>
        ) : displayTree.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-gray-500">
            {searchQuery ? "No matching files" : "Empty project"}
          </div>
        ) : (
          displayTree.map((node) => (
            <TreeNode key={node.path} node={node} depth={0} source="project" />
          ))
        )}
      </div>

      {currentProject && (
        <div className="px-2.5 py-1 border-t border-editor-border text-[10px] text-gray-500 truncate">
          {currentProject.name}
        </div>
      )}
    </div>
  );
}

/* ── OutputExplorer (generated code) ──────────────────── */
export function OutputExplorer() {
  const { outputRunId, currentProject, currentRun, setActiveSidebarTab } = useStore();
  const outputTreeQuery = useOutputTree(outputRunId);
  const outputTree = outputTreeQuery.data?.tree ?? [];
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const handleDownload = async () => {
    if (!outputRunId) return;
    setDownloading(true);
    try {
      await downloadPipelineOutput(outputRunId);
    } finally {
      setDownloading(false);
    }
  };

  const handleExtract = async () => {
    if (!outputRunId || !currentProject) return;
    setExtracting(true);
    try {
      await extractOutputToProject(outputRunId, currentProject.project_id);
      queryClient.invalidateQueries({ queryKey: queryKeys.codeBuilder.fileTree(currentProject.project_id) });
      setActiveSidebarTab("explorer");
    } catch (err) {
      console.error("Extract failed:", err);
    } finally {
      setExtracting(false);
    }
  };

  const fileCount = countFiles(outputTree);

  return (
    <div className="h-full flex flex-col">
      {/* header */}
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <FolderArchive size={12} className="text-emerald-400" />
          <span>Generated Code</span>
        </div>
        {outputRunId && (
          <span className="text-[10px] text-gray-500">{fileCount} files</span>
        )}
      </div>

      {/* action bar */}
      {outputRunId && outputTree.length > 0 && (
        <div className="flex gap-1.5 px-2 py-1.5 border-b border-editor-border">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                       bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
          >
            <Download size={10} />
            {downloading ? "Downloading…" : "Download ZIP"}
          </button>
          {currentProject && (
            <button
              onClick={handleExtract}
              disabled={extracting}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                         bg-editor-accent hover:bg-editor-accentHover text-white transition-colors disabled:opacity-50"
            >
              <Package size={10} />
              {extracting ? "Extracting…" : "Extract"}
            </button>
          )}
        </div>
      )}

      {/* tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!outputRunId || outputTree.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-gray-500">
            <FolderArchive size={20} className="mx-auto mb-2 opacity-20" />
            <p>No generated output yet</p>
            <p className="opacity-60 mt-1">Run a pipeline to see generated code</p>
          </div>
        ) : (
          outputTree.map((node) => (
            <TreeNode key={node.path} node={node} depth={0} source="output" runId={outputRunId} />
          ))
        )}
      </div>
    </div>
  );
}

function countFiles(nodes: FileNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.type === "file") count++;
    if (n.children) count += countFiles(n.children);
  }
  return count;
}
