"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Braces,
  Search,
  Hash,
  Type,
  ToggleLeft,
  List,
  FileJson,
} from "lucide-react";

interface DependencyGraphViewerProps {
  json: unknown;
  className?: string;
}

/* ── Value type icon ────────────────────────────────────────────────── */

function ValueIcon({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <ToggleLeft className="w-3 h-3 text-gray-500 shrink-0" />;
  if (typeof value === "number")
    return <Hash className="w-3 h-3 text-blue-400 shrink-0" />;
  if (typeof value === "boolean")
    return <ToggleLeft className="w-3 h-3 text-amber-400 shrink-0" />;
  if (typeof value === "string")
    return <Type className="w-3 h-3 text-green-400 shrink-0" />;
  if (Array.isArray(value))
    return <List className="w-3 h-3 text-purple-400 shrink-0" />;
  return <Braces className="w-3 h-3 text-cbv2-accent shrink-0" />;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

/* ── Recursive JSON tree node ────────────────────────────────────── */

function JsonTreeNode({
  label,
  value,
  depth,
  defaultExpanded,
  searchTerm,
}: {
  label: string;
  value: unknown;
  depth: number;
  defaultExpanded: boolean;
  searchTerm: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);
  const entries = isObject
    ? isArray
      ? value.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>)
    : [];

  const matchesSearch =
    searchTerm &&
    (label.toLowerCase().includes(searchTerm) ||
      (!isObject && formatValue(value).toLowerCase().includes(searchTerm)));

  return (
    <div>
      <div
        className={[
          "flex items-center gap-1.5 py-[3px] text-[11px] font-mono transition-colors duration-75 rounded-sm",
          isObject ? "cursor-pointer hover:bg-cbv2-hover" : "hover:bg-cbv2-hover/50",
          matchesSearch ? "bg-cbv2-accent/15 ring-1 ring-cbv2-accent/30" : "",
        ].join(" ")}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => isObject && setExpanded((v) => !v)}
      >
        {isObject ? (
          expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-cbv2-text-dim shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-cbv2-text-dim shrink-0" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <ValueIcon value={value} />
        <span className="text-cbv2-accent font-medium">{label}</span>
        <span className="text-cbv2-text-dim mx-0.5">:</span>
        {isObject ? (
          <span className="text-cbv2-text-dim text-[10px]">
            {isArray ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        ) : (
          <span
            className={[
              "truncate",
              typeof value === "string"
                ? "text-green-400"
                : typeof value === "number"
                  ? "text-blue-400"
                  : typeof value === "boolean"
                    ? "text-amber-400"
                    : "text-gray-500",
            ].join(" ")}
          >
            {formatValue(value)}
          </span>
        )}
      </div>
      {isObject && expanded && (
        <div>
          {entries.map(([key, val]) => (
            <JsonTreeNode
              key={key}
              label={key}
              value={val}
              depth={depth + 1}
              defaultExpanded={depth < 1}
              searchTerm={searchTerm}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Viewer ─────────────────────────────────────────────────── */

export default function DependencyGraphViewer({
  json,
  className,
}: DependencyGraphViewerProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [copied, setCopied] = useState(false);

  const entries = useMemo(() => {
    if (json === null || json === undefined) return [];
    if (typeof json !== "object") return [["root", json] as [string, unknown]];
    return Array.isArray(json)
      ? json.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(json as Record<string, unknown>);
  }, [json]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [json]);

  return (
    <div
      className={
        className ||
        "rounded-lg border border-cbv2-border bg-cbv2-sidebar overflow-hidden flex flex-col"
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cbv2-border bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-amber-500/15 flex items-center justify-center">
            <FileJson className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <span className="text-[11px] font-semibold text-cbv2-text">
            Dependency Graph
          </span>
          <span className="text-[10px] text-cbv2-text-dim">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
            <input
              className="pl-6 pr-2 py-1 w-28 bg-cbv2-input border border-cbv2-border rounded text-[10px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none transition-colors"
              placeholder="Filter..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value.toLowerCase())}
            />
          </div>
          <button
            className="p-1.5 rounded-md hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={handleCopy}
            title="Copy JSON"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Tree */}
      <div
        className="overflow-auto cbv2-scrollbar py-1 flex-1"
        style={{ minHeight: 200 }}
      >
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim">
            <Braces className="w-8 h-8 opacity-30 mb-2" />
            <p className="text-[11px]">No data to display</p>
          </div>
        ) : (
          entries.map(([key, val]) => (
            <JsonTreeNode
              key={key}
              label={key}
              value={val}
              depth={0}
              defaultExpanded={true}
              searchTerm={searchTerm}
            />
          ))
        )}
      </div>
    </div>
  );
}
