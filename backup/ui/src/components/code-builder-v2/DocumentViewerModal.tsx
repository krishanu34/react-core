"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useProjectDocumentArtifacts } from "@/hooks/useCodeBuilderQueries";
import type { CBv2Artifact } from "@/types/code-builder-v2";
import { formatValue, formatFallbackContent } from "@/lib/format-content";
import {
  ArtifactFilterChips,
  RunFlagBadges,
  applyArtifactFilter,
  getArtifactFilterCounts,
  type ArtifactFilter,
} from "./ArtifactFilterChips";
import { Star, Flag } from "lucide-react";
import {
  X,
  Search,
  Eye,
  CheckSquare,
  Square,
  FileText,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  FileCode,
  BookOpen,
  ClipboardList,
  Layers,
  Code,
  TestTube,
} from "lucide-react";

/* ── Types ────────────────────────────────────────────────────────────── */

interface DocumentGroup {
  doc_type: string;
  doc_type_label: string;
  documents: CBv2Artifact[];
}

/* ── Badge colours ────────────────────────────────────────────────────── */

const TYPE_COLORS: Record<string, string> = {
  hld_document: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  lld_document: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  req_document: "bg-green-500/20 text-green-300 border-green-500/30",
  requirements_document: "bg-green-500/20 text-green-300 border-green-500/30",
  srs_document: "bg-green-500/20 text-green-300 border-green-500/30",
  ddd_document: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  api_spec_document: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  test_plan_document: "bg-pink-500/20 text-pink-300 border-pink-500/30",
  architecture_synthesis: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

const TYPE_LABELS: Record<string, string> = {
  hld_document: "High-Level Design",
  lld_document: "Low-Level Design",
  req_document: "Requirements",
  requirements_document: "Requirements",
  srs_document: "Software Requirements Spec",
  ddd_document: "Domain-Driven Design",
  api_spec_document: "API Specification",
  test_plan_document: "Test Plan",
  architecture_synthesis: "Architecture Synthesis",
};

const TYPE_ICONS: Record<string, React.ElementType> = {
  hld_document: BookOpen,
  lld_document: FileCode,
  req_document: ClipboardList,
  requirements_document: ClipboardList,
  srs_document: ClipboardList,
  ddd_document: Layers,
  api_spec_document: Code,
  test_plan_document: TestTube,
  architecture_synthesis: Layers,
  custom: FileText,
};

/* ── Document content renderer ───────────────────────────────────────── */

function DocumentContent({ document }: { document: CBv2Artifact }) {
  const [copied, setCopied] = useState(false);
  const content = document.content ?? {};

  const sections: { label: string; value: string }[] = [];

  if (document.description) {
    sections.push({ label: "Description", value: document.description });
  }

  if (typeof content === "object" && content !== null) {
    // Handle markdown content (common in design documents)
    if ((content as Record<string, unknown>).markdown) {
      sections.push({
        label: "Content",
        value: (content as Record<string, unknown>).markdown as string,
      });
    }

    // Handle sections array (HLD/LLD structure)
    if (Array.isArray((content as Record<string, unknown>).sections)) {
      const contentSections = (content as Record<string, unknown>).sections as Array<{
        title?: string;
        content?: string;
        markdown?: string;
      }>;
      for (const sec of contentSections) {
        if (sec.title && (sec.content || sec.markdown)) {
          sections.push({
            label: sec.title,
            value: sec.content || sec.markdown || "",
          });
        }
      }
    }

    // Handle other common keys
    const keyMap: Record<string, string> = {
      summary: "Summary",
      overview: "Overview",
      architecture: "Architecture",
      components: "Components",
      requirements: "Requirements",
      api_endpoints: "API Endpoints",
      test_cases: "Test Cases",
      diagrams: "Diagrams",
    };

    for (const [key, label] of Object.entries(keyMap)) {
      const val = (content as Record<string, unknown>)[key];
      if (!val || key === "sections" || key === "markdown") continue;

      const formatted = formatValue(val);
      if (formatted) {
        sections.push({ label, value: formatted });
      }
    }
  }

  // Fallback: show formatted content if nothing else parsed
  if (sections.length === 0 && content && Object.keys(content).length > 0) {
    sections.push({
      label: "Content",
      value: formatFallbackContent(content as Record<string, unknown>),
    });
  }

  const fullText = sections.map((s) => `## ${s.label}\n${s.value}`).join("\n\n");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fullText]);

  return (
    <div className="space-y-3">
      {sections.length === 0 ? (
        <p className="text-[12px] text-cbv2-text-dim italic">No content available.</p>
      ) : (
        <>
          <div className="flex justify-end">
            <button
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors"
              onClick={handleCopy}
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied" : "Copy All"}
            </button>
          </div>
          {sections.map((section, idx) => (
            <div key={idx}>
              <h4 className="text-[11px] font-semibold text-cbv2-accent uppercase tracking-wide mb-1">
                {section.label}
              </h4>
              <div className="text-[12px] text-cbv2-text leading-relaxed whitespace-pre-wrap break-words bg-cbv2-input rounded px-3 py-2 border border-cbv2-border">
                {section.value}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ── Document row ─────────────────────────────────────────────────────── */

function DocumentRow({
  document,
  isSelected,
  isActive,
  onToggle,
  onView,
}: {
  document: CBv2Artifact;
  isSelected: boolean;
  isActive: boolean;
  onToggle: () => void;
  onView: () => void;
}) {
  return (
    <div
      className={[
        "flex items-center gap-3 px-4 py-2.5 border-b border-cbv2-border transition-colors cursor-pointer group",
        isActive
          ? "bg-cbv2-accent/10 border-l-2 border-l-cbv2-accent"
          : "hover:bg-cbv2-hover border-l-2 border-l-transparent",
      ].join(" ")}
      onClick={onView}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) => { e.stopPropagation(); onToggle(); }}
        onClick={(e) => e.stopPropagation()}
        className="accent-cbv2-accent w-4 h-4 rounded cursor-pointer flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-medium text-cbv2-text truncate">
            {document.title}
          </span>
          <span
            className={[
              "text-[9px] px-1.5 py-0.5 rounded border font-medium flex-shrink-0",
              TYPE_COLORS[document.artifact_type] ?? "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
            ].join(" ")}
          >
            {TYPE_LABELS[document.artifact_type] ?? document.artifact_type.replace("_", " ")}
          </span>
          <RunFlagBadges
            starred={document.run_is_selected}
            flagged={document.run_review_flag}
            size="xs"
          />
        </div>
        {document.description && (
          <p className="text-[11px] text-cbv2-text-dim mt-0.5 line-clamp-1">
            {document.description}
          </p>
        )}
      </div>
      <span className="text-[10px] text-cbv2-text-dim font-mono flex-shrink-0">
        #{document.id}
      </span>
      <Eye className="w-3.5 h-3.5 text-cbv2-text-dim opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </div>
  );
}

/* ── Document type group section ───────────────────────────────────────── */

function DocumentTypeSection({
  group,
  activeId,
  selectedIds,
  onToggle,
  onView,
}: {
  group: DocumentGroup;
  activeId: number | null;
  selectedIds: number[];
  onToggle: (id: number) => void;
  onView: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const selectedCount = group.documents.filter((d) => selectedIds.includes(d.id)).length;
  const starredCount = group.documents.filter((d) => d.run_is_selected).length;
  const flaggedCount = group.documents.filter((d) => d.run_review_flag).length;
  const Icon = TYPE_ICONS[group.doc_type] ?? FileText;

  return (
    <div>
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[12px] font-semibold text-cbv2-text hover:bg-cbv2-hover transition-colors bg-cbv2-sidebar border-b border-cbv2-border"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-cbv2-accent" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-cbv2-accent" />
        )}
        <Icon className="w-4 h-4 text-cbv2-accent" />
        <span className="flex-1 text-left">{group.doc_type_label}</span>
        {(starredCount > 0 || flaggedCount > 0) && (
          <span className="flex items-center gap-1">
            {starredCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-yellow-300 font-mono"
                title={`${starredCount} starred`}
              >
                <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                {starredCount}
              </span>
            )}
            {flaggedCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-orange-300 font-mono"
                title={`${flaggedCount} flagged`}
              >
                <Flag className="w-3 h-3 fill-orange-400 text-orange-400" />
                {flaggedCount}
              </span>
            )}
          </span>
        )}
        <span className="text-[10px] font-mono text-cbv2-text-dim">
          {selectedCount > 0 && (
            <span className="text-cbv2-accent mr-1">{selectedCount}/</span>
          )}
          {group.documents.length}
        </span>
      </button>
      {open &&
        group.documents.map((doc) => (
          <DocumentRow
            key={doc.id}
            document={doc}
            isSelected={selectedIds.includes(doc.id)}
            isActive={activeId === doc.id}
            onToggle={() => onToggle(doc.id)}
            onView={() => onView(doc.id)}
          />
        ))}
    </div>
  );
}

/* ── Main Modal ───────────────────────────────────────────────────────── */

interface DocumentViewerModalProps {
  projectId: number;
  initialSelectedIds?: number[];
  onClose: () => void;
  onDocumentsSelected: (docIds: number[], documents: CBv2Artifact[]) => void;
}

export default function DocumentViewerModal({
  projectId,
  initialSelectedIds = [],
  onClose,
  onDocumentsSelected,
}: DocumentViewerModalProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [selectedIds, setSelectedIds] = useState<number[]>(initialSelectedIds);
  const [activeDocId, setActiveDocId] = useState<number | null>(null);
  const [isMaximized, setIsMaximized] = useState(true);

  // ── Load data via React Query ──────────────────────────────────────
  const { data: rawDocs = [], isLoading: loading } = useProjectDocumentArtifacts(projectId);

  // Per-type grouping: each artifact_type gets its own collapsible
  // section so users can clearly see HLDs vs LLDs vs Requirements vs
  // any custom document type. Anything not in the recognised list ends
  // up under "Custom Documents" instead of being silently merged.
  const KNOWN_DOC_TYPES = [
    "hld_document",
    "lld_document",
    "req_document",
    "requirements_document",
    "srs_document",
    "ddd_document",
    "api_spec_document",
    "test_plan_document",
  ];

  const allDocuments: CBv2Artifact[] = rawDocs as unknown as CBv2Artifact[];

  const documentGroups = useMemo<DocumentGroup[]>(() => {
    const byType = new Map<string, CBv2Artifact[]>();
    for (const doc of allDocuments) {
      const key = doc.artifact_type || "custom";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(doc);
    }

    const groups: DocumentGroup[] = [];
    for (const t of KNOWN_DOC_TYPES) {
      const docs = byType.get(t);
      if (!docs || docs.length === 0) continue;
      groups.push({
        doc_type: t,
        doc_type_label: TYPE_LABELS[t] || t.replace(/_document$/, "").toUpperCase(),
        documents: docs,
      });
    }

    // Custom catch-all for any unknown artifact_type so we never silently
    // hide documents that come from new / experimental pipelines.
    const customDocs: CBv2Artifact[] = [];
    for (const [t, docs] of byType.entries()) {
      if (!KNOWN_DOC_TYPES.includes(t)) customDocs.push(...docs);
    }
    if (customDocs.length > 0) {
      groups.push({
        doc_type: "custom",
        doc_type_label: "Custom Documents",
        documents: customDocs,
      });
    }

    return groups;
  }, [allDocuments]);

  // Auto-select first document when data arrives
  const firstDocId = allDocuments[0]?.id ?? null;
  if (activeDocId === null && firstDocId !== null) {
    setActiveDocId(firstDocId);
  }

  // ── Filtered documents ─────────────────────────────────────────────
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return documentGroups
      .map((g) => ({
        ...g,
        documents: applyArtifactFilter(g.documents, filter).filter(
          (d) =>
            !q ||
            d.title.toLowerCase().includes(q) ||
            (d.description ?? "").toLowerCase().includes(q) ||
            g.doc_type_label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.documents.length > 0);
  }, [documentGroups, search, filter]);

  const filterCounts = useMemo(
    () => getArtifactFilterCounts(allDocuments),
    [allDocuments],
  );

  const activeDocument = allDocuments.find((d) => d.id === activeDocId) ?? null;
  const allSelected = allDocuments.length > 0 && selectedIds.length === allDocuments.length;

  // ── Toggle document ────────────────────────────────────────────────
  const toggleDocument = useCallback((id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((sid) => sid !== id) : [...prev, id]
    );
  }, []);

  // ── Toggle all ─────────────────────────────────────────────────────
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? [] : allDocuments.map((d) => d.id));
  }, [allSelected, allDocuments]);

  // ── Done ───────────────────────────────────────────────────────────
  const handleDone = useCallback(() => {
    const selected = allDocuments.filter((d) => selectedIds.includes(d.id));
    onDocumentsSelected(selectedIds, selected);
    onClose();
  }, [selectedIds, allDocuments, onDocumentsSelected, onClose]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className={[
          "bg-cbv2-bg border border-cbv2-border rounded-lg shadow-2xl flex flex-col overflow-hidden transition-all duration-200",
          isMaximized ? "w-[95vw] h-[90vh]" : "w-[80vw] h-[70vh] max-w-[1200px]",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cbv2-border bg-cbv2-sidebar shrink-0">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-cbv2-accent" />
            <h2 className="text-[14px] font-semibold text-cbv2-text">
              Project Documents
            </h2>
            <span className="px-2 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent text-[11px] font-mono">
              {allDocuments.length} total
            </span>
            {selectedIds.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 text-[11px] font-mono">
                {selectedIds.length} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
              onClick={() => setIsMaximized((m) => !m)}
              title={isMaximized ? "Restore size" : "Maximize"}
            >
              {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              className="p-1.5 rounded hover:bg-red-500/20 text-cbv2-text-dim hover:text-red-400 transition-colors"
              onClick={onClose}
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-cbv2-border bg-cbv2-sidebar shrink-0 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
            <input
              className="w-full pl-8 pr-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${allDocuments.length} documents...`}
              autoFocus
            />
          </div>
          <ArtifactFilterChips
            value={filter}
            onChange={setFilter}
            counts={filterCounts}
            size="sm"
          />
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cbv2-border text-[11px] hover:border-cbv2-accent/30 transition-colors text-cbv2-text-dim hover:text-cbv2-accent"
            onClick={toggleAll}
          >
            {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {allSelected ? "Deselect All" : "Select All"}
          </button>
        </div>

        {/* Body — split pane */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-[12px] text-cbv2-text-dim">Loading documents...</div>
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            {/* Left: documents grouped by type */}
            <div className="w-[40%] border-r border-cbv2-border overflow-y-auto cbv2-scrollbar">
              {filteredGroups.map((group) => (
                <DocumentTypeSection
                  key={group.doc_type}
                  group={group}
                  activeId={activeDocId}
                  selectedIds={selectedIds}
                  onToggle={toggleDocument}
                  onView={setActiveDocId}
                />
              ))}
              {filteredGroups.length === 0 && (
                <div className="flex items-center justify-center py-8 text-[11px] text-cbv2-text-dim">
                  {search
                    ? `No documents matching "${search}"`
                    : filter !== "all"
                      ? `No ${filter} documents in this project.`
                      : "No design documents found for this project."}
                </div>
              )}
            </div>

            {/* Right: document detail */}
            <div className="flex-1 overflow-y-auto cbv2-scrollbar p-4">
              {activeDocument ? (
                <>
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-[16px] font-semibold text-cbv2-text">
                        {activeDocument.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span
                          className={[
                            "text-[10px] px-2 py-0.5 rounded border font-medium",
                            TYPE_COLORS[activeDocument.artifact_type] ??
                              "bg-cbv2-input text-cbv2-text-dim border-cbv2-border",
                          ].join(" ")}
                        >
                          {TYPE_LABELS[activeDocument.artifact_type] ?? activeDocument.artifact_type.replace("_", " ")}
                        </span>
                        <span className="text-[11px] text-cbv2-text-dim font-mono">
                          #{activeDocument.id}
                        </span>
                        {activeDocument.version && (
                          <span className="text-[10px] text-cbv2-text-dim">
                            v{activeDocument.version}
                          </span>
                        )}
                        <RunFlagBadges
                          starred={activeDocument.run_is_selected}
                          flagged={activeDocument.run_review_flag}
                          size="sm"
                        />
                      </div>
                    </div>
                    <button
                      className={[
                        "flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium transition-colors",
                        selectedIds.includes(activeDocument.id)
                          ? "bg-cbv2-accent text-white"
                          : "bg-cbv2-input text-cbv2-text border border-cbv2-border hover:border-cbv2-accent/40",
                      ].join(" ")}
                      onClick={() => toggleDocument(activeDocument.id)}
                    >
                      {selectedIds.includes(activeDocument.id) ? (
                        <CheckSquare className="w-3.5 h-3.5" />
                      ) : (
                        <Square className="w-3.5 h-3.5" />
                      )}
                      {selectedIds.includes(activeDocument.id) ? "Selected" : "Select"}
                    </button>
                  </div>
                  <DocumentContent document={activeDocument} />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-cbv2-text-dim text-[12px]">
                  Select a document from the list to view details
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-cbv2-border bg-cbv2-sidebar flex items-center justify-between shrink-0">
          <span className="text-[11px] text-cbv2-text-dim">
            {selectedIds.length} of {allDocuments.length} documents selected
          </span>
          <button
            className="px-4 py-1.5 rounded bg-cbv2-accent text-white text-[12px] font-medium hover:bg-cbv2-accent/80 transition-colors"
            onClick={handleDone}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
