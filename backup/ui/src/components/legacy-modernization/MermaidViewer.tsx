"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import {
  AlertCircle,
  Copy,
  Check,
  GitBranch,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { sanitizeMermaidCode } from "@/lib/mermaid-utils";

interface MermaidViewerProps {
  code: string;
  className?: string;
  title?: string;
}

let mermaidInitialized = false;
function ensureMermaidInitialized() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    maxTextSize: 500000,
    themeVariables: {
      primaryColor: "#007acc",
      primaryTextColor: "#d4d4d4",
      primaryBorderColor: "#3c3c3c",
      lineColor: "#8c8c8c",
      secondaryColor: "#252526",
      tertiaryColor: "#1e1e1e",
    },
  });
  mermaidInitialized = true;
}

function buildMermaidCandidates(code: string): string[] {
  const normalized = sanitizeMermaidCode(code);
  const candidates = [normalized];

  if (!/^(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|journey|gantt|stateDiagram|mindmap|timeline|gitGraph)\b/i.test(normalized)) {
    candidates.push(`flowchart TD\n${normalized}`);
  }

  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
}

export default function MermaidViewer({ code, className, title }: MermaidViewerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const diagramId = useMemo(
    () => `mermaid_${reactId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    [reactId]
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.innerHTML = "";
    setLoading(true);
    setError(null);

    let cancelled = false;
    (async () => {
      try {
        ensureMermaidInitialized();
        let lastError: unknown = null;

        for (const [index, candidate] of buildMermaidCandidates(code).entries()) {
          try {
            const result = await mermaid.render(`${diagramId}_${index}`, candidate);
            if (cancelled) return;

            el.innerHTML = result.svg;
            result.bindFunctions?.(el);
            setLoading(false);
            return;
          } catch (err) {
            lastError = err;
          }
        }

        throw lastError ?? new Error("Invalid Mermaid syntax");
      } catch (err) {
        if (cancelled) return;
        el.textContent = "";
        console.warn("Mermaid render failed", err);
        setError("Diagram syntax is invalid. Regenerate the document to get a corrected diagram.");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div
      className={
        className ??
        "rounded-lg border border-cbv2-border bg-cbv2-sidebar overflow-hidden"
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cbv2-border bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-purple-500/15 flex items-center justify-center">
            <GitBranch className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <span className="text-[11px] font-semibold text-cbv2-text">
            {title || "Dependency Diagram"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            title="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-cbv2-text-dim w-8 text-center font-mono">
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            title="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={() => setZoom(1)}
            title="Reset zoom"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-cbv2-border mx-0.5" />
          <button
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={handleCopyCode}
            title="Copy Mermaid code"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Diagram area */}
      <div className="overflow-auto cbv2-scrollbar p-4" style={{ minHeight: 300 }}>
        {loading && (
          <div className="flex items-center justify-center py-12 text-cbv2-text-dim">
            <Loader2 className="w-5 h-5 animate-spin mr-2 text-cbv2-accent" />
            <span className="text-[11px]">Rendering diagram...</span>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center mb-3">
              <AlertCircle className="w-5 h-5 text-red-400" />
            </div>
            <p className="text-[12px] font-medium text-red-400 mb-1">
              Diagram render failed
            </p>
            <p className="text-[10px] text-cbv2-text-dim max-w-[300px] text-center">
              {error}
            </p>
          </div>
        )}
        <div
          ref={ref}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            transition: "transform 0.2s ease",
          }}
          className={loading ? "hidden" : ""}
        />
      </div>
    </div>
  );
}
