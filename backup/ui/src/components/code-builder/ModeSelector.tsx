"use client";

import {
  Rocket,
  Factory,
  GitMerge,
  Bug,
  ArrowRightLeft,
  Brain,
  Boxes,
  ChevronDown,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useStore } from "@/store/useCodeBuilderStore";
import type { PipelineMode } from "@/types/code-builder";
import { PIPELINE_LABELS, PIPELINE_DESCRIPTIONS } from "@/types/code-builder";

const MODE_ICONS: Record<PipelineMode, React.ReactNode> = {
  greenfield:    <Rocket size={16} className="text-emerald-400" />,
  brownfield:    <Factory size={16} className="text-amber-400" />,
  hybrid:        <GitMerge size={16} className="text-purple-400" />,
  hotfix:        <Bug size={16} className="text-red-400" />,
  migration:     <ArrowRightLeft size={16} className="text-blue-400" />,
  code_intel:    <Brain size={16} className="text-cyan-400" />,
  microservice:  <Boxes size={16} className="text-orange-400" />,
};

const MODES: PipelineMode[] = [
  "greenfield", "brownfield", "hybrid", "hotfix",
  "migration", "code_intel", "microservice",
];

export default function ModeSelector() {
  const { pipelineMode, setPipelineMode } = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /* close on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={dropdownRef} className="relative">
      {/* trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-md
                   bg-editor-input border border-editor-border
                   hover:border-editor-accent transition-colors text-sm"
      >
        {MODE_ICONS[pipelineMode]}
        <span className="flex-1 text-left font-medium">
          {PIPELINE_LABELS[pipelineMode]}
        </span>
        <ChevronDown
          size={14}
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* dropdown */}
      {isOpen && (
        <div
          className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md
                     bg-editor-sidebar border border-editor-border shadow-xl
                     max-h-[320px] overflow-y-auto animate-fade-in"
        >
          {MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setPipelineMode(mode);
                setIsOpen(false);
              }}
              className={`
                flex items-start gap-2.5 w-full px-3 py-2.5 text-left
                hover:bg-editor-active transition-colors
                ${mode === pipelineMode ? "bg-editor-highlight" : ""}
              `}
            >
              <span className="mt-0.5">{MODE_ICONS[mode]}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium">{PIPELINE_LABELS[mode]}</div>
                <div className="text-[11px] text-gray-500 leading-tight mt-0.5">
                  {PIPELINE_DESCRIPTIONS[mode]}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
