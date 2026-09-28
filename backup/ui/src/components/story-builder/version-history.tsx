"use client";

import { useState } from "react";
import { History, Loader2, Check, Clock, GitBranch, ChevronDown, ChevronRight, X, MessageSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useArtifactVersions } from "@/hooks/useStoryBuilderQueries";
import type { VersionInfo } from "@/lib/api";

interface VersionHistoryProps {
  /** Database ID of any version of the artifact */
  artifactId: number;
  /** Called when user clicks a version to set it as active */
  onSelectVersion?: (version: VersionInfo) => void;
  /** Whether a version selection is currently in progress */
  isSelecting?: boolean;
  /** @deprecated No longer needed — React Query auto-refetches on invalidation */
  refreshKey?: number;
}

export function VersionHistory({
  artifactId,
  onSelectVersion,
  isSelecting,
}: VersionHistoryProps) {
  const { data: versions = [], isLoading: loading, error: queryError } = useArtifactVersions(artifactId);
  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load versions") : null;
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-sm py-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading version history…
      </div>
    );
  }

  if (error) {
    return <div className="text-xs text-red-400 py-2">{error}</div>;
  }

  if (versions.length <= 1) {
    return (
      <div className="text-xs text-slate-600 py-2 flex items-center gap-1">
        <History className="h-3 w-3" />
        No previous versions
      </div>
    );
  }

  /** Render version content in a readable way */
  function renderContent(content: Record<string, unknown>) {
    if (!content || Object.keys(content).length === 0) {
      return <p className="text-xs text-slate-500 italic">No content available</p>;
    }

    const isEpicContent =
      Object.prototype.hasOwnProperty.call(content, "epic_id") ||
      Object.prototype.hasOwnProperty.call(content, "epic_goal") ||
      Object.prototype.hasOwnProperty.call(content, "epic_description");

    // Filter out noisy/empty/duplicate fields.
    // "title" and "description" are skipped because v.title is already shown in the
    // version button header above the content panel.
    // "feature_name" and "epic_name" mirror v.title for their respective artifact
    // types, so showing them in the content panel would duplicate the header (AC5).
    const skipKeys = new Set([
      "features", "metadata",
      "title", "description",
      "feature_name", "epic_name",   // already shown via v.title in button header
      "artifact_type", "artifact_id",
    ]);
    const importantKeys = ["epic_id", "feature_id", "story_id",
      "epic_goal", "feature_description",
      "business_rules", "acceptance_criteria", "technical_changes",
      "implementation_notes", "story_points", "business_value", "group_name"];

    const entries = Object.entries(content).filter(([k, v]) => {
      if (skipKeys.has(k)) return false;
      if (isEpicContent && (k === "epic_goal" || k === "business_value" || k === "citation_metadata")) return false;
      if (v === null || v === undefined || v === "") return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    });

    // Sort: important keys first
    entries.sort((a, b) => {
      const ai = importantKeys.indexOf(a[0]);
      const bi = importantKeys.indexOf(b[0]);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a[0].localeCompare(b[0]);
    });

    return (
      <div className="space-y-2">
        {entries.map(([key, value]) => (
          <div key={key}>
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              {key.replace(/_/g, " ")}
            </span>
            {typeof value === "string" ? (
              <p className="text-xs text-slate-300 mt-0.5 whitespace-pre-wrap">{value}</p>
            ) : Array.isArray(value) ? (
              <ul className="list-disc list-inside mt-0.5 space-y-0.5">
                {(value as unknown[]).map((item: unknown, idx: number) => (
                  <li key={idx} className="text-xs text-slate-300">
                    {typeof item === "string" ? item : JSON.stringify(item, null, 2)}
                  </li>
                ))}
              </ul>
            ) : typeof value === "number" ? (
              <p className="text-xs text-slate-300 mt-0.5">{value}</p>
            ) : (
              <pre className="text-xs text-slate-400 mt-0.5 bg-slate-900/50 p-2 rounded overflow-x-auto max-h-48">
                {JSON.stringify(value, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {/* Show metadata separately if it exists and has content */}
        {content.metadata != null && typeof content.metadata === "object" &&
          Object.keys(content.metadata as Record<string, unknown>).length > 0 && (
          <div>
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              metadata
            </span>
            <pre className="text-xs text-slate-400 mt-0.5 bg-slate-900/50 p-2 rounded overflow-x-auto max-h-48">
              {JSON.stringify(content.metadata as Record<string, unknown>, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <Card className="border-slate-700/50">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Version History ({versions.length})
          </span>
        </div>
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[7px] top-3 bottom-3 w-px bg-slate-700" />

          <div className="space-y-1">
            {versions.map((v, i) => {
              const isLatest = v.is_latest_version;
              const isApproved = v.is_approved;
              const isFirst = i === 0;
              const isExpanded = expandedId === v.id;

              return (
                <div key={v.id}>
                  <button
                    onClick={() => {
                      setExpandedId(isExpanded ? null : v.id);
                      onSelectVersion?.(v);
                    }}
                    className={`relative w-full text-left pl-6 pr-2 py-1.5 rounded-md transition-colors hover:bg-slate-800/50 group ${
                      isLatest ? "bg-slate-800/30" : ""
                    } ${isExpanded ? "bg-slate-800/60" : ""}`}
                  >
                    {/* Timeline dot */}
                    <div
                      className={`absolute left-0.5 top-3 h-3.5 w-3.5 rounded-full border-2 ${
                        isLatest
                          ? "border-sky-500 bg-sky-500/30"
                          : isApproved
                            ? "border-emerald-500 bg-emerald-500/30"
                            : "border-slate-600 bg-slate-800"
                      }`}
                    />

                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-slate-500 mt-0.5">
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </span>
                      <span className="shrink-0 text-xs font-mono font-semibold text-slate-300">
                        v{v.version}
                      </span>
                      {isLatest && (
                        <Badge variant="default" className="shrink-0 text-[10px] px-1.5 py-0">
                          Latest
                        </Badge>
                      )}
                      {isApproved && (
                        <Badge variant="success" className="shrink-0 text-[10px] px-1.5 py-0">
                          <Check className="h-2.5 w-2.5 mr-0.5" />
                          Approved
                        </Badge>
                      )}
                      {isFirst && (
                        <span className="shrink-0 text-[10px] text-slate-600">Original</span>
                      )}
                      {v.quality_score != null && (
                        <span className="shrink-0 text-[10px] text-slate-500 ml-auto">
                          Q: {v.quality_score.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {v.title && (
                      <p className="text-sm text-slate-100 font-medium mt-1 pl-5 line-clamp-2">
                        {v.title}
                      </p>
                    )}
                    {v.created_at && (
                      <div className="flex items-center gap-1 text-[10px] text-slate-600 mt-0.5 pl-5">
                        <Clock className="h-2.5 w-2.5" />
                        {new Date(v.created_at).toLocaleString()}
                      </div>
                    )}
                  </button>

                  {/* Expanded content panel */}
                  {isExpanded && (
                    <div className="ml-6 mt-1 mb-2 p-3 rounded-md bg-slate-900/60 border border-slate-700/50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                          Version {v.version} Content
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 text-slate-500 hover:text-slate-300"
                          onClick={(e) => { e.stopPropagation(); setExpandedId(null); }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      {/* Show refinement prompt if this version was refined */}
                      {v.refinement_prompt && (
                        <div className="mb-3 p-2 rounded-md bg-sky-950/30 border border-sky-800/30">
                          <span className="text-[10px] font-semibold text-sky-400 uppercase tracking-wider flex items-center gap-1">
                            <MessageSquare className="h-2.5 w-2.5" />
                            refinement prompt
                          </span>
                          <p className="text-xs text-slate-300 mt-1 whitespace-pre-wrap">{v.refinement_prompt}</p>
                        </div>
                      )}
                      {/* Show title & description from DB columns (always present) */}
                      {v.title && (
                        <div className="mb-2">
                          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">title</span>
                          <p className="text-xs text-slate-300 mt-0.5">{v.title}</p>
                        </div>
                      )}
                      {v.description && (
                        <div className="mb-2">
                          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">description</span>
                          <p className="text-xs text-slate-300 mt-0.5 whitespace-pre-wrap">{v.description}</p>
                        </div>
                      )}
                      {renderContent(v.content)}
                      {/* Use this version button — only shown for non-latest versions */}
                      {!isLatest && onSelectVersion && (
                        <div className="mt-3 pt-2 border-t border-slate-700/50 flex justify-end">
                          <Button
                            size="sm"
                            className="h-7 px-3 text-xs bg-sky-600 hover:bg-sky-500 text-white"
                            onClick={(e) => { e.stopPropagation(); onSelectVersion(v); }}
                            disabled={isSelecting}
                          >
                            {isSelecting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                            Use this version
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
