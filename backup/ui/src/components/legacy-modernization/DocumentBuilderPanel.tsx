"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Loader2,
  XCircle,
} from "lucide-react";
import MarkdownViewer from "./MarkdownViewer";
import type {
  DocumentTypeInfo,
  GeneratedDocument,
} from "@/lib/legacy-modernization-api";
import {
  getDocumentTypes,
  generateDocument,
  getDocumentDownloadUrl,
} from "@/lib/legacy-modernization-api";

/* ── Props ───────────────────────────────────────────────────────────── */

interface DocumentBuilderPanelProps {
  workspaceRoot: string;
  projectName?: string;
  targetStack?: string;
  modernizationGoal?: string;
  onClose?: () => void;
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function DocumentBuilderPanel({
  workspaceRoot,
  projectName,
  targetStack,
  modernizationGoal,
  onClose,
}: DocumentBuilderPanelProps) {
  const [docTypes, setDocTypes] = useState<DocumentTypeInfo[]>([]);
  const [selectedType, setSelectedType] = useState("full_report");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GeneratedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  /* Fetch available document types on mount */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDocumentTypes()
      .then((data) => {
        if (!cancelled) {
          setDocTypes(data.document_types ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setDocTypes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  /* Generate document */
  const handleGenerate = useCallback(async () => {
    if (!workspaceRoot) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const doc = await generateDocument(
        workspaceRoot,
        selectedType,
        projectName,
        targetStack,
        modernizationGoal,
      );
      setResult(doc);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate document";
      setError(msg);
    } finally {
      setGenerating(false);
    }
  }, [workspaceRoot, selectedType, projectName, targetStack, modernizationGoal]);

  /* Download URL */
  const downloadUrl = workspaceRoot
    ? getDocumentDownloadUrl(workspaceRoot, selectedType, projectName, targetStack, modernizationGoal)
    : null;

  const selectedInfo = docTypes.find((d) => d.document_type === selectedType);

  return (
    <div className="flex flex-col h-full bg-cbv2-bg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cbv2-border bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-500/15 flex items-center justify-center">
            <FileText className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <span className="text-[12px] font-semibold text-cbv2-text">Document Builder</span>
        </div>
        {onClose && (
          <button
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            onClick={onClose}
            title="Close"
          >
            <XCircle className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="px-3 py-3 space-y-3 border-b border-cbv2-border bg-cbv2-sidebar/50 shrink-0">
        {/* Document type selector */}
        <div className="space-y-1">
          <label className="text-[10px] text-cbv2-text-dim uppercase tracking-wider font-semibold">
            Document Type
          </label>
          <div className="relative">
            <button
              type="button"
              className="w-full flex items-center justify-between px-2.5 py-1.5 bg-cbv2-input border border-cbv2-border rounded-lg text-[11px] text-cbv2-text hover:border-cbv2-accent/50 transition-colors"
              onClick={() => setDropdownOpen((v) => !v)}
              disabled={loading}
            >
              <span>{selectedInfo?.document_type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? selectedType}</span>
              <ChevronDown className={`w-3.5 h-3.5 text-cbv2-text-dim transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
            </button>
            {dropdownOpen && (
              <div className="absolute z-20 mt-1 w-full bg-cbv2-sidebar border border-cbv2-border rounded-lg shadow-xl overflow-hidden">
                {docTypes.map((dt) => (
                  <button
                    key={dt.document_type}
                    className={`w-full text-left px-2.5 py-2 text-[11px] hover:bg-cbv2-accent/10 transition-colors ${
                      dt.document_type === selectedType
                        ? "text-cbv2-accent bg-cbv2-accent/5"
                        : "text-cbv2-text"
                    }`}
                    onClick={() => {
                      setSelectedType(dt.document_type);
                      setDropdownOpen(false);
                      setResult(null);
                      setError(null);
                    }}
                  >
                    <div className="font-medium">
                      {dt.document_type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </div>
                    <div className="text-[10px] text-cbv2-text-dim mt-0.5">{dt.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Info about selected type */}
        {selectedInfo && (
          <div className="text-[10px] text-cbv2-text-dim">
            {selectedInfo.total_sections} sections &middot; {selectedInfo.description}
          </div>
        )}

        {/* Generate button */}
        <button
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cbv2-accent text-white text-[11px] font-medium hover:bg-cbv2-accent/80 transition-colors disabled:opacity-50"
          onClick={handleGenerate}
          disabled={generating || !workspaceRoot}
        >
          {generating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Assembling...
            </>
          ) : (
            <>
              <FileText className="w-3.5 h-3.5" />
              Generate Document
            </>
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
            {error}
          </div>
        )}
      </div>

      {/* Results / Preview */}
      <div className="flex-1 overflow-auto cbv2-scrollbar">
        {result ? (
          <div className="space-y-0">
            {/* Section status bar */}
            <div className="px-3 py-2 border-b border-cbv2-border bg-cbv2-sidebar/40 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-cbv2-text uppercase tracking-wider">Sections</span>
                <span className="text-[10px] text-cbv2-text-dim">
                  {result.present_sections.length} / {result.present_sections.length + result.missing_sections.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {result.present_sections.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20"
                  >
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    {s.replace(/_/g, " ")}
                  </span>
                ))}
                {result.missing_sections.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  >
                    <XCircle className="w-2.5 h-2.5" />
                    {s.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>

            {/* Download bar */}
            {downloadUrl && (
              <div className="px-3 py-2 border-b border-cbv2-border bg-cbv2-sidebar/30">
                <a
                  href={downloadUrl}
                  download
                  className="inline-flex items-center gap-1.5 text-[11px] text-cbv2-accent hover:text-cbv2-accent/80 transition-colors font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Markdown
                </a>
              </div>
            )}

            {/* Markdown preview */}
            <MarkdownViewer
              content={result.markdown}
              title={result.title}
              className="border-0 rounded-none bg-cbv2-bg"
            />
          </div>
        ) : !generating ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 opacity-60">
            <FileText className="w-10 h-10 text-cbv2-text-dim mb-3" />
            <p className="text-[11px] text-cbv2-text-dim leading-relaxed max-w-[200px]">
              Select a document type and click &ldquo;Generate&rdquo; to assemble
              a report from your analysis artifacts.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
