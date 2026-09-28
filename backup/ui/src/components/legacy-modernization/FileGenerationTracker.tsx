"use client";

import React from "react";
import {
  CheckCircle2,
  FileCode,
  Loader2,
} from "lucide-react";

/* ── Types ───────────────────────────────────────────────────────────── */

interface FileGenerationTrackerProps {
  manifest: Array<{ path: string; description: string }>;
  generatingFiles: string[];
  completedFiles: string[];
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function FileGenerationTracker({
  manifest,
  generatingFiles,
  completedFiles,
}: FileGenerationTrackerProps) {
  if (manifest.length === 0) return null;

  const completedSet = new Set(completedFiles);
  const generatingSet = new Set(generatingFiles);

  return (
    <div className="rounded-xl border border-cbv2-border bg-cbv2-bg/60 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-cbv2-border/50 bg-gradient-to-r from-blue-500/5 to-transparent">
        <FileCode className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-[11px] font-semibold text-cbv2-text">
          Files ({completedFiles.length}/{manifest.length})
        </span>
        <div className="ml-auto flex-1 max-w-[80px] h-1.5 bg-cbv2-input rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-400 rounded-full transition-all duration-500"
            style={{
              width: `${Math.round((completedFiles.length / manifest.length) * 100)}%`,
            }}
          />
        </div>
      </div>

      {/* File list (max height with scroll) */}
      <div className="max-h-[200px] overflow-y-auto cbv2-scrollbar py-1">
        {manifest.map((file) => {
          const isCompleted = completedSet.has(file.path);
          const isGenerating = generatingSet.has(file.path);
          const fileName = file.path.split("/").pop() || file.path;
          const folder = file.path.split("/").slice(0, -1).join("/");

          return (
            <div
              key={file.path}
              className={[
                "flex items-center gap-2 px-3 py-1 transition-colors",
                isGenerating
                  ? "bg-cbv2-accent/5"
                  : isCompleted
                    ? "opacity-70"
                    : "",
              ].join(" ")}
            >
              {isCompleted ? (
                <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
              ) : isGenerating ? (
                <Loader2 className="w-3 h-3 text-cbv2-accent animate-spin shrink-0" />
              ) : (
                <div className="w-3 h-3 rounded-full border border-cbv2-border shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <span className="text-[10px] text-cbv2-text truncate block">{fileName}</span>
                {folder && (
                  <span className="text-[9px] text-cbv2-text-dim truncate block">{folder}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
