"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  FileText,
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  Copy,
  Check,
  FileJson,
  FileCode,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import { getRunReports, readReportFile } from "@/lib/code-builder-api";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

/* ═══════════════════════════════════════════════════════════
 * ReportViewer — Full-width report reading experience
 *
 * Shows a list of reports on the left and content on the right.
 * Supports .md, .json, .yaml, .txt files.
 * ═══════════════════════════════════════════════════════════ */
export default function ReportViewer() {
  const {
    viewerReport,
    setViewerReport,
    viewerRunId,
    setMainView,
  } = useStore();

  const [reports, setReports] = useState<{ path: string; name: string; language: string; size: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  /* Reset selectedPath when run changes */
  useEffect(() => {
    setSelectedPath(null);
  }, [viewerRunId]);

  /* Fetch report list */
  useEffect(() => {
    if (!viewerRunId) return;
    setLoading(true);
    getRunReports(viewerRunId)
      .then(data => {
        setReports(data.reports);
        // Auto-expand all groups
        const groups = new Set<string>();
        data.reports.forEach(r => {
          const parts = r.path.split("/");
          if (parts.length > 1) groups.add(parts[0]);
        });
        setExpandedGroups(groups);

        // If viewerReport was pre-loaded (e.g. from a "View Report" button),
        // sync selectedPath to it instead of auto-selecting the first report.
        const currentViewerReport = useStore.getState().viewerReport;
        if (currentViewerReport?.path && currentViewerReport.content) {
          // Pre-loaded report — just mark it as selected in the sidebar
          setSelectedPath(currentViewerReport.path);
        } else if (data.reports.length > 0) {
          // No pre-loaded report — auto-select first md report
          const md = data.reports.find(r => r.name.endsWith(".md"));
          if (md) handleSelectReport(md.path);
          else handleSelectReport(data.reports[0].path);
        }
      })
      .catch(err => console.error("Failed to load reports:", err))
      .finally(() => setLoading(false));
  }, [viewerRunId]);

  const handleSelectReport = useCallback(async (path: string) => {
    if (!viewerRunId) return;
    setSelectedPath(path);
    setLoadingFile(true);
    try {
      const data = await readReportFile(viewerRunId, path);
      setViewerReport({
        path,
        content: data.content,
        language: data.language,
        size: data.size,
      });
    } catch (err) {
      console.error("Failed to read report:", err);
    } finally {
      setLoadingFile(false);
    }
  }, [viewerRunId, setViewerReport]);

  const handleCopy = useCallback(() => {
    if (viewerReport?.content) {
      navigator.clipboard.writeText(viewerReport.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [viewerReport]);

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  /* Group reports by directory */
  const grouped: Record<string, typeof reports> = {};
  reports.forEach(r => {
    const parts = r.path.split("/");
    const group = parts.length > 1 ? parts[0] : "root";
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(r);
  });

  function fileIcon(name: string) {
    if (name.endsWith(".md")) return <FileText size={13} className="text-blue-400 shrink-0" />;
    if (name.endsWith(".json")) return <FileJson size={13} className="text-yellow-400 shrink-0" />;
    return <FileCode size={13} className="text-gray-400 shrink-0" />;
  }

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-editor-sidebar border-b border-editor-border shrink-0">
        <button
          onClick={() => setMainView("editor")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                     bg-editor-input border border-editor-border hover:bg-editor-active
                     text-gray-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <FileText size={15} className="text-purple-400" />
        <span className="text-sm font-semibold text-white">Report Viewer</span>
        {viewerRunId && (
          <span className="text-[10px] text-gray-500 font-mono">Run: {viewerRunId}</span>
        )}
        <div className="flex-1" />
        {viewerReport && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500">{viewerReport.path}</span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                         bg-editor-input hover:bg-editor-active text-gray-300 transition-colors"
            >
              {copied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: report list */}
        <div className="w-[240px] shrink-0 bg-editor-sidebar border-r border-editor-border overflow-y-auto">
          <div className="px-3 py-2 border-b border-editor-border">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
              Reports ({reports.length})
            </span>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-editor-accent" />
            </div>
          ) : (
            <div className="py-1">
              {Object.entries(grouped).map(([group, files]) => (
                <div key={group}>
                  {group !== "root" && (
                    <button
                      onClick={() => toggleGroup(group)}
                      className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] text-gray-400
                                 hover:bg-editor-active transition-colors font-medium"
                    >
                      {expandedGroups.has(group) ? (
                        <>
                          <ChevronDown size={11} />
                          <FolderOpen size={13} className="text-amber-400" />
                        </>
                      ) : (
                        <>
                          <ChevronRight size={11} />
                          <Folder size={13} className="text-amber-400" />
                        </>
                      )}
                      <span>{group}/</span>
                    </button>
                  )}
                  {(group === "root" || expandedGroups.has(group)) &&
                    files.map(f => (
                      <button
                        key={f.path}
                        onClick={() => handleSelectReport(f.path)}
                        className={`flex items-center gap-1.5 w-full text-left text-[11px]
                          hover:bg-editor-active transition-colors
                          ${selectedPath === f.path
                            ? "bg-editor-highlight text-white"
                            : "text-gray-300"
                          }`}
                        style={{ paddingLeft: group === "root" ? "12px" : "28px", paddingTop: "4px", paddingBottom: "4px" }}
                      >
                        {fileIcon(f.name)}
                        <span className="truncate">{f.name}</span>
                        <span className="text-[9px] text-gray-600 ml-auto shrink-0">
                          {(f.size / 1024).toFixed(1)}KB
                        </span>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: content */}
        <div className="flex-1 min-w-0">
          {loadingFile ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={20} className="animate-spin text-editor-accent" />
            </div>
          ) : viewerReport ? (
            <Editor
              key={viewerReport.path}
              defaultValue={viewerReport.content}
              language={viewerReport.language === "markdown" ? "markdown" : viewerReport.language}
              theme="vs-dark"
              options={{
                readOnly: true,
                fontSize: 13,
                fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
                minimap: { enabled: true },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                padding: { top: 8 },
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <FileText size={36} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm">Select a report to view</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
