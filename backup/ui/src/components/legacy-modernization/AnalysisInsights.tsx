"use client";

import React, { useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Code2,
  FileCode,
  FolderOpen,
  Layers,
  Sparkles,
  XCircle,
} from "lucide-react";

/* ── Types ───────────────────────────────────────────────────────────── */

interface AnalysisInsightsProps {
  metrics: {
    totalFiles: number;
    sourceFiles: number;
    primaryLanguage: string;
    languageCounts: Record<string, number>;
    importantFilesCount: number;
    excludedFiles: number;
    analysisMode: string;
  } | null;
  phaseTimings: Record<string, number>;
}

/* ── Language Bar Chart ───────────────────────────────────────────────── */

const LANGUAGE_COLORS: Record<string, string> = {
  Python: "bg-yellow-400",
  JavaScript: "bg-amber-400",
  TypeScript: "bg-blue-400",
  Java: "bg-red-400",
  "C#": "bg-purple-400",
  Go: "bg-cyan-400",
  Ruby: "bg-red-300",
  PHP: "bg-indigo-400",
  Rust: "bg-orange-400",
  C: "bg-gray-400",
  "C++": "bg-pink-400",
  Swift: "bg-orange-300",
  Kotlin: "bg-purple-300",
  SQL: "bg-green-400",
  HTML: "bg-orange-500",
  CSS: "bg-blue-300",
  SCSS: "bg-pink-300",
  Shell: "bg-green-300",
};

function getLanguageColor(lang: string): string {
  return LANGUAGE_COLORS[lang] ?? "bg-cbv2-accent";
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function AnalysisInsights({
  metrics,
  phaseTimings,
}: AnalysisInsightsProps) {
  const [expanded, setExpanded] = useState(false);

  if (!metrics) return null;

  const {
    totalFiles,
    sourceFiles,
    primaryLanguage,
    languageCounts,
    importantFilesCount,
    excludedFiles,
    analysisMode,
  } = metrics;

  const sortedLanguages = Object.entries(languageCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  const maxLangCount = sortedLanguages.length > 0 ? sortedLanguages[0][1] : 1;

  return (
    <div className="rounded-lg border border-cbv2-border bg-cbv2-bg/60 overflow-hidden">
      {/* Compact summary bar — always visible, clickable to expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-cbv2-input/40 transition-colors"
      >
        <BarChart3 className="w-3 h-3 text-cbv2-accent shrink-0" />
        <span className="text-[10px] font-semibold text-cbv2-text">Analysis</span>
        <span className="text-[10px] text-cbv2-text-dim">
          {totalFiles} files · {primaryLanguage} · {sourceFiles} source
          {importantFilesCount > 0 && ` · ${importantFilesCount} key`}
        </span>
        <span className="ml-auto text-[9px] text-cbv2-text-dim px-1 py-0.5 rounded bg-cbv2-input border border-cbv2-border/50">
          {analysisMode === "generic_llm" ? "AI" : "Heuristic"}
        </span>
        {expanded ? (
          <ChevronUp className="w-3 h-3 text-cbv2-text-dim shrink-0" />
        ) : (
          <ChevronDown className="w-3 h-3 text-cbv2-text-dim shrink-0" />
        )}
      </button>

      {/* Expandable detail section */}
      {expanded && (
        <>
          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-px bg-cbv2-border/30 border-t border-cbv2-border/30">
            <div className="bg-cbv2-bg/80 px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1 mb-0.5">
                <FolderOpen className="w-3 h-3 text-blue-400" />
              </div>
              <div className="text-[12px] font-bold text-cbv2-text tabular-nums">{totalFiles}</div>
              <div className="text-[9px] text-cbv2-text-dim">Total Files</div>
            </div>
            <div className="bg-cbv2-bg/80 px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1 mb-0.5">
                <FileCode className="w-3 h-3 text-green-400" />
              </div>
              <div className="text-[12px] font-bold text-cbv2-text tabular-nums">{sourceFiles}</div>
              <div className="text-[9px] text-cbv2-text-dim">Source Files</div>
            </div>
            <div className="bg-cbv2-bg/80 px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1 mb-0.5">
                <Code2 className="w-3 h-3 text-amber-400" />
              </div>
              <div className="text-[12px] font-bold text-cbv2-text truncate">{primaryLanguage}</div>
              <div className="text-[9px] text-cbv2-text-dim">Primary Lang</div>
            </div>
          </div>

          {/* Additional stats row */}
          <div className="flex items-center gap-3 px-3 py-1 border-t border-cbv2-border/30 bg-cbv2-bg/40">
            <div className="flex items-center gap-1 text-[10px] text-cbv2-text-dim">
              <Sparkles className="w-3 h-3 text-purple-400" />
              <span className="text-cbv2-text font-medium">{importantFilesCount}</span> key files
            </div>
            {excludedFiles > 0 && (
              <div className="flex items-center gap-1 text-[10px] text-cbv2-text-dim">
                <XCircle className="w-3 h-3 text-red-400/60" />
                <span>{excludedFiles}</span> excluded
              </div>
            )}
            {phaseTimings.total && (
              <div className="flex items-center gap-1 text-[10px] text-cbv2-text-dim ml-auto">
                <Layers className="w-3 h-3 text-cyan-400" />
                <span>{phaseTimings.total}s</span> analysis
              </div>
            )}
          </div>

          {/* Language breakdown bar chart */}
          {sortedLanguages.length > 0 && (
            <div className="px-3 py-1.5 border-t border-cbv2-border/30 space-y-1">
              <div className="text-[10px] font-medium text-cbv2-text-dim uppercase tracking-wider">
                Language Breakdown
              </div>
              {sortedLanguages.map(([lang, count]) => {
                const pct = Math.round((count / maxLangCount) * 100);
                const totalPct = sourceFiles > 0 ? Math.round((count / sourceFiles) * 100) : 0;
                return (
                  <div key={lang} className="flex items-center gap-2">
                    <span className="text-[10px] text-cbv2-text w-16 truncate shrink-0">{lang}</span>
                    <div className="flex-1 h-2 bg-cbv2-input rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${getLanguageColor(lang)}`}
                        style={{ width: `${pct}%`, opacity: 0.8 }}
                      />
                    </div>
                    <span className="text-[9px] text-cbv2-text-dim tabular-nums w-12 text-right shrink-0">
                      {count} ({totalPct}%)
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
