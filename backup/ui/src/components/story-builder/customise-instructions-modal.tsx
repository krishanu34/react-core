"use client";

import { useState } from "react";
import { X, SlidersHorizontal, RotateCcw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PipelineFlowchartConfig } from "@/components/story-builder/pipeline-flowchart";

// ─────────────────────────────────────────────────────────────────────────────
// Stage definitions
// ─────────────────────────────────────────────────────────────────────────────

interface InstructableStage {
  id: string;
  num: string;
  label: string;
  hint: string;
  alwaysOn: boolean;
  /** returns true when this stage is active given current config */
  isActive: (cfg: PipelineFlowchartConfig) => boolean;
}

const INSTRUCTABLE_STAGES: InstructableStage[] = [
  {
    id: "global",
    num: "Global",
    label: "Global Instructions",
    hint: "Applied to every LLM call in the pipeline. Use this to enforce tone, output style or domain-specific terminology.",
    alwaysOn: true,
    isActive: () => true,
  },
  {
    id: "stage_2_feature_extraction",
    num: "Stage 2",
    label: "Feature / Epic Extraction",
    hint: "Guide how features (or epics) are identified from the requirements document. E.g. 'Focus on payment-related features only'.",
    alwaysOn: false,
    isActive: (cfg) => cfg.epicMode !== "story_only",
  },
  {
    id: "stage_5_code_context",
    num: "Stage 5",
    label: "Code Context",
    hint: "Instructions for how code context should be interpreted or filtered when enriching stories.",
    alwaysOn: false,
    isActive: (cfg) => cfg.useCode,
  },
  {
    id: "stage_6_figma_context",
    num: "Stage 6",
    label: "Figma Context",
    hint: "Instructions for how Figma design context should be applied during story generation.",
    alwaysOn: false,
    isActive: (cfg) => cfg.useFigma,
  },
  {
    id: "stage_8_project_context",
    num: "Stage 8",
    label: "Project Context",
    hint: "Instructions for how architecture / ADR docs should influence generated stories.",
    alwaysOn: false,
    isActive: (cfg) => cfg.useProject,
  },
  {
    id: "stage_9_story_generation",
    num: "Stage 9",
    label: "Story Generation",
    hint: "Core generation prompt override. E.g. 'Generate stories in BDD format' or 'Each story must include a Definition of Done'.",
    alwaysOn: true,
    isActive: () => true,
  },
  {
    id: "stage_11_self_refinement",
    num: "Stage 11",
    label: "Self-Refinement",
    hint: "Criteria used when refining story quality. E.g. 'Ensure all acceptance criteria are testable'.",
    alwaysOn: true,
    isActive: () => true,
  },
  {
    id: "stage_11_15_epic_extraction",
    num: "Stage 11.15",
    label: "Epic Grouping",
    hint: "Instructions for how features should be grouped into epics.",
    alwaysOn: false,
    isActive: (cfg) => cfg.epicMode === "epic_feature_story",
  },
  {
    id: "stage_13_standards_validation",
    num: "Stage 13",
    label: "Standards Validation",
    hint: "Instructions for the TMForum standards validation pass. E.g. 'Prioritise eTOM L2 process alignment'.",
    alwaysOn: false,
    isActive: (cfg) => cfg.useStandards,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomiseInstructionsModalProps {
  open: boolean;
  onClose: () => void;
  config: PipelineFlowchartConfig;
  instructions: Record<string, string>;
  onChange: (updated: Record<string, string>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────────────

export function CustomiseInstructionsModal({
  open,
  onClose,
  config,
  instructions,
  onChange,
}: CustomiseInstructionsModalProps) {
  const [local, setLocal] = useState<Record<string, string>>(() => ({ ...instructions }));
  const [activeStageId, setActiveStageId] = useState<string>("global");

  if (!open) return null;

  const visibleStages = INSTRUCTABLE_STAGES.filter((s) => s.alwaysOn || s.isActive(config));
  const activeStage = visibleStages.find((s) => s.id === activeStageId) ?? visibleStages[0];

  const handleSave = () => {
    // Strip blank entries before saving
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(local)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onChange(cleaned);
    onClose();
  };

  const handleReset = (id: string) => {
    setLocal((prev) => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleResetAll = () => {
    setLocal({});
  };

  const filledCount = Object.values(local).filter((v) => v.trim()).length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-10 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col max-h-[80vh]">

        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-100">Customise Instructions</h2>
            {filledCount > 0 && (
              <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white">
                {filledCount} set
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body: sidebar + editor ── */}
        <div className="flex flex-1 overflow-hidden">

          {/* Stage list */}
          <nav className="w-44 shrink-0 border-r border-slate-800 overflow-y-auto py-2">
            {visibleStages.map((stage) => {
              const hasValue = !!local[stage.id]?.trim();
              const isSkipped = !stage.alwaysOn && !stage.isActive(config);
              return (
                <button
                  key={stage.id}
                  onClick={() => setActiveStageId(stage.id)}
                  className={cn(
                    "w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors text-[11px] leading-snug",
                    activeStageId === stage.id
                      ? "bg-indigo-600/15 text-indigo-300"
                      : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300",
                    isSkipped && "opacity-40",
                  )}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className={cn(
                      "text-[9px] font-bold uppercase tracking-widest",
                      activeStageId === stage.id ? "text-indigo-500/70" : "text-slate-600",
                    )}>
                      {stage.num}
                    </span>
                    <span className="font-medium leading-tight">{stage.label}</span>
                  </div>
                  {hasValue && (
                    <span className="ml-auto mt-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Editor panel */}
          <div className="flex flex-col flex-1 p-5 overflow-y-auto gap-3">
            {activeStage && (
              <>
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        {activeStage.num}
                      </p>
                      <h3 className="text-sm font-semibold text-slate-100 mt-0.5">
                        {activeStage.label}
                      </h3>
                    </div>
                    {local[activeStage.id]?.trim() && (
                      <button
                        onClick={() => handleReset(activeStage.id)}
                        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-red-400 transition-colors shrink-0"
                      >
                        <RotateCcw className="h-3 w-3" /> Clear
                      </button>
                    )}
                  </div>
                  <p className="flex items-start gap-1.5 mt-2 text-[11px] text-slate-500 leading-relaxed">
                    <Info className="h-3 w-3 mt-0.5 shrink-0 text-slate-600" />
                    {activeStage.hint}
                  </p>
                </div>

                <textarea
                  rows={8}
                  placeholder={`Add custom instructions for ${activeStage.label}…`}
                  value={local[activeStage.id] ?? ""}
                  onChange={(e) =>
                    setLocal((prev) => ({ ...prev, [activeStage.id]: e.target.value }))
                  }
                  className={cn(
                    "w-full resize-none rounded-lg border bg-slate-800/50 px-3 py-2.5 text-xs text-slate-200 placeholder-slate-600",
                    "focus:outline-none focus:ring-1 focus:ring-indigo-500",
                    "border-slate-700 transition-colors",
                  )}
                />

                {!activeStage.alwaysOn && !activeStage.isActive(config) && (
                  <p className="text-[10px] text-amber-500/70">
                    This stage is currently skipped based on your configuration. Instructions will be saved but won't be applied unless the stage is enabled.
                  </p>
                )}

                <p className="text-[10px] text-slate-600">
                  {(local[activeStage.id] ?? "").length} characters
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between border-t border-slate-700 px-5 py-4 shrink-0">
          <button
            onClick={handleResetAll}
            className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-red-400 transition-colors"
          >
            <RotateCcw className="h-3 w-3" /> Reset all
          </button>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} className="gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Apply Instructions
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
