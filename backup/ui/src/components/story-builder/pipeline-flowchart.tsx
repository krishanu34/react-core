"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil, Plus, Check, X, RotateCcw, MessageSquarePlus, Bold, Italic, Code, List, ListOrdered, Quote } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EpicMode, QualityLevel, StandardsType } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineFlowchartConfig {
  useEpics: boolean;
  epicMode: EpicMode;
  useCode: boolean;
  useProject: boolean;
  useFigma: boolean;
  useStandards: boolean;
  stdTypes: StandardsType[];
  quality: QualityLevel;
}

export interface PipelineFlowchartProps {
  config: PipelineFlowchartConfig;
  instructions?: Record<string, string>;
  onInstructionChange?: (stageId: string, value: string) => void;
  /** Key-value pairs for additional fields to include in every generated story */
  storyFields?: Record<string, string>;
  onStoryFieldsChange?: (fields: Record<string, string>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting toolbar + helper
// ─────────────────────────────────────────────────────────────────────────────

function insertFormatting(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  draft: string,
  setDraft: (v: string) => void,
  type: "bold" | "italic" | "code" | "bullet" | "numbered" | "quote",
) {
  const el = ref.current;
  if (!el) return;
  const start = el.selectionStart;
  const end   = el.selectionEnd;
  const sel   = draft.slice(start, end);
  let result  = draft;
  let newStart = start;
  let newEnd   = end;

  if (type === "bold")     { const t = sel || "bold text";     result = draft.slice(0, start) + `**${t}**`     + draft.slice(end); newStart = start + 2; newEnd = newStart + t.length; }
  if (type === "italic")   { const t = sel || "italic text";   result = draft.slice(0, start) + `*${t}*`       + draft.slice(end); newStart = start + 1; newEnd = newStart + t.length; }
  if (type === "code")     { const t = sel || "code";          result = draft.slice(0, start) + `\`${t}\``     + draft.slice(end); newStart = start + 1; newEnd = newStart + t.length; }
  if (type === "bullet")   { const lineStart = draft.lastIndexOf("\n", start - 1) + 1; result = draft.slice(0, lineStart) + "- " + draft.slice(lineStart); newStart = start + 2; newEnd = end + 2; }
  if (type === "numbered") { const lineStart = draft.lastIndexOf("\n", start - 1) + 1; result = draft.slice(0, lineStart) + "1. " + draft.slice(lineStart); newStart = start + 3; newEnd = end + 3; }
  if (type === "quote")    { const lineStart = draft.lastIndexOf("\n", start - 1) + 1; result = draft.slice(0, lineStart) + "> " + draft.slice(lineStart); newStart = start + 2; newEnd = end + 2; }

  setDraft(result);
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(newStart, newEnd); });
}

interface FormatToolbarProps {
  draft: string;
  setDraft: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function FormatToolbar({ draft, setDraft, textareaRef }: FormatToolbarProps) {
  const btn = (label: string, icon: React.ReactNode, type: Parameters<typeof insertFormatting>[3]) => (
    <button
      type="button"
      title={label}
      onMouseDown={(e) => { e.preventDefault(); insertFormatting(textareaRef, draft, setDraft, type); }}
      className="flex items-center justify-center rounded p-1 text-slate-500 hover:bg-slate-700/50 hover:text-amber-400 transition-colors"
    >
      {icon}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 border-b border-amber-900/30 bg-slate-900/40 px-2 py-1">
      {btn("Bold",          <Bold          className="h-3 w-3" />, "bold")}
      {btn("Italic",        <Italic        className="h-3 w-3" />, "italic")}
      {btn("Inline code",   <Code          className="h-3 w-3" />, "code")}
      <span className="w-px h-3 bg-slate-700 mx-0.5" />
      {btn("Bullet list",   <List          className="h-3 w-3" />, "bullet")}
      {btn("Numbered list", <ListOrdered   className="h-3 w-3" />, "numbered")}
      {btn("Block quote",   <Quote         className="h-3 w-3" />, "quote")}
      <span className="ml-auto text-[8px] text-slate-700">markdown</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline instruction editor attached to a stage node
// ─────────────────────────────────────────────────────────────────────────────

interface InlineNoteProps {
  stageId: string;
  instruction: string;
  onSave: (val: string) => void;
  disabled?: boolean;
}

function InlineNote({ stageId: _stageId, instruction, onSave, disabled }: InlineNoteProps) {
  const [open, setOpen]   = useState(false);
  const [draft, setDraft] = useState(instruction);
  const [side, setSide]   = useState<"right" | "left">("right");
  const wrapperRef        = useRef<HTMLDivElement>(null);
  const textareaRef       = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(instruction); }, [instruction]);
  useEffect(() => { if (open && textareaRef.current) textareaRef.current.focus(); }, [open]);

  const handleOpen = () => {
    if (disabled) return;
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setSide((window.innerWidth - rect.right) >= rect.left ? "right" : "left");
    }
    setDraft(instruction);
    setOpen(true);
  };
  const handleConfirm = useCallback(() => { onSave(draft.trim()); setOpen(false); }, [draft, onSave]);
  const handleCancel  = () => { setDraft(instruction); setOpen(false); };
  const handleClear   = () => { setDraft(""); onSave(""); setOpen(false); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { handleCancel(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleConfirm();
  };

  if (disabled) return null;

  return (
    <div ref={wrapperRef} className="relative mt-1.5 flex justify-center">

      {/* ── Collapsed: instruction exists */}
      {!open && instruction.trim() && (
        <div
          onClick={handleOpen}
          className="group/note relative w-full cursor-pointer rounded-md border border-dashed border-amber-700/50 bg-amber-950/20 px-2.5 py-1.5 text-[10px] transition-all duration-150 hover:border-amber-600/70 hover:bg-amber-950/30"
        >
          <div className="flex items-start justify-between gap-1.5">
            <p className="text-amber-400/80 leading-relaxed line-clamp-2 flex-1">{instruction}</p>
            <button
              onClick={(e) => { e.stopPropagation(); handleOpen(); }}
              className="shrink-0 mt-0.5 opacity-0 group-hover/note:opacity-100 transition-opacity text-amber-500 hover:text-amber-300"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); handleClear(); }}
            className="absolute -top-1.5 -right-1.5 opacity-0 group-hover/note:opacity-100 transition-opacity rounded-full bg-slate-800 border border-slate-700 p-px text-slate-500 hover:text-red-400"
          >
            <X className="h-2 w-2" />
          </button>
        </div>
      )}

      {/* ── Collapsed: no instruction */}
      {!open && !instruction.trim() && (
        <button
          onClick={handleOpen}
          className="group/btn flex items-center gap-1.5 rounded-md border border-dashed border-amber-900/50 bg-amber-950/10 px-2.5 py-1 text-[9px] font-semibold tracking-wide text-amber-700 transition-all duration-150 hover:border-amber-600/60 hover:bg-amber-950/30 hover:text-amber-400"
        >
          <MessageSquarePlus className="h-3 w-3 transition-colors group-hover/btn:text-amber-400" />
          Add instruction
        </button>
      )}

      {/* ── Floating editor panel (left or right of node) */}
      {open && (
        <>
          {/* invisible spacer keeps the node column from collapsing */}
          <div className="invisible pointer-events-none h-6 w-full" />
          <div className={cn(
            "absolute top-1/2 -translate-y-1/2 z-30 w-80 rounded-lg border border-amber-600/50 bg-slate-900 shadow-xl shadow-black/50 overflow-visible",
            side === "right" ? "left-[calc(100%+10px)]" : "right-[calc(100%+10px)]",
          )}>
            {/* pointing arrow */}
            <div className={cn(
              "absolute top-1/2 -translate-y-1/2 border-y-4 border-y-transparent",
              side === "right"
                ? "-left-[6px] border-r-[6px] border-r-amber-600/50"
                : "-right-[6px] border-l-[6px] border-l-amber-600/50",
            )} />
            <div className="overflow-hidden rounded-lg">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1 border-b border-amber-900/20">
                <MessageSquarePlus className="h-3 w-3 text-amber-500/60 shrink-0" />
                <p className="text-[9px] font-bold uppercase tracking-widest text-amber-600/70">Stage Instruction</p>
                <button onClick={handleCancel} className="ml-auto rounded p-0.5 text-slate-600 hover:text-slate-400 transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </div>
              <FormatToolbar draft={draft} setDraft={setDraft} textareaRef={textareaRef} />
              <textarea
                ref={textareaRef}
                rows={4}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={'Add a custom instruction for this stage… e.g. "Output in British English", "Always include Acceptance Criteria"'}
                className="w-full resize-y bg-transparent px-3 py-2 text-xs text-amber-200/80 placeholder-slate-700 focus:outline-none leading-relaxed min-h-[80px]"
              />
              <div className="flex items-center justify-between border-t border-amber-900/30 bg-slate-900/60 px-3 py-1.5">
                <div className="flex items-center gap-3">
                  {draft.trim() && (
                    <button onClick={handleClear} className="flex items-center gap-0.5 text-[9px] text-slate-600 hover:text-red-400 transition-colors">
                      <RotateCcw className="h-2.5 w-2.5" /> Clear
                    </button>
                  )}
                  <span className="text-[9px] text-slate-700">{draft.length} chars · ⌘↵ save</span>
                </div>
                <button
                  onClick={handleConfirm}
                  className="rounded bg-amber-700/40 px-2.5 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-600/50 transition-colors flex items-center gap-1"
                >
                  <Check className="h-3 w-3" /> Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage node with optional inline note
// ─────────────────────────────────────────────────────────────────────────────

type StageVariant = "core" | "active" | "skipped";

interface StageNodeProps {
  stageId?: string;
  label: string;
  sub?: string;
  stageNum: string;
  variant: StageVariant;
  badge?: string;
  className?: string;
  tooltip?: string;
  instruction?: string;
  onInstructionChange?: (stageId: string, val: string) => void;
}

function StageNode({
  stageId, label, sub, stageNum, variant, badge, className, tooltip,
  instruction = "", onInstructionChange,
}: StageNodeProps) {
  const editable = !!stageId && !!onInstructionChange && variant !== "skipped";
  const hasNote  = !!instruction.trim();

  return (
    <div className={cn("group flex flex-col", editable && "cursor-default")}>
      <div className={cn(
        "relative flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-center text-xs transition-all duration-200 min-w-[130px]",
        variant === "core"    && "border-emerald-600/60 bg-emerald-950/30 text-emerald-300",
        variant === "active"  && "border-indigo-500/60 bg-indigo-950/30 text-indigo-300",
        variant === "skipped" && "border-slate-700/50 bg-slate-900/30 text-slate-600 opacity-50 border-dashed",
        hasNote && variant !== "skipped" && "border-amber-700/60",
        className,
      )}>
        {hasNote && (
          <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-500 shadow shadow-amber-900/50" />
        )}
        <span className={cn(
          "text-[9px] font-semibold uppercase tracking-widest",
          variant === "core"    && "text-emerald-500/70",
          variant === "active"  && "text-indigo-500/70",
          variant === "skipped" && "text-slate-700",
        )}>
          {stageNum}
        </span>
        <span className="font-semibold leading-tight">{label}</span>
        {sub && (
          <span className={cn("text-[9px] leading-tight opacity-70", variant === "skipped" && "line-through")}>
            {sub}
          </span>
        )}
        {badge && (
          <span className={cn(
            "absolute -top-2 left-1/2 -translate-x-1/2 rounded px-1.5 py-px text-[8px] font-bold uppercase tracking-wider whitespace-nowrap",
            variant === "active"  && "bg-indigo-600 text-white",
            variant === "skipped" && "bg-slate-700 text-slate-400",
          )}>
            {badge}
          </span>
        )}
        {/* Hover tooltip */}
        {tooltip && (
          <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 z-40 w-52 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-left shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <p className="text-[10px] leading-relaxed text-slate-300">{tooltip}</p>
            {/* arrow */}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-x-4 border-x-transparent border-t-4 border-t-slate-700" />
          </div>
        )}
      </div>

      {editable && stageId && onInstructionChange && (
        <InlineNote
          stageId={stageId}
          instruction={instruction}
          onSave={(val) => onInstructionChange(stageId, val)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Global instruction banner
// ─────────────────────────────────────────────────────────────────────────────

interface GlobalBannerProps {
  instruction: string;
  onSave: (val: string) => void;
}

function GlobalBanner({ instruction, onSave }: GlobalBannerProps) {
  const [open, setOpen]   = useState(false);
  const [draft, setDraft] = useState(instruction);
  const textareaRef       = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(instruction); }, [instruction]);
  useEffect(() => { if (open && textareaRef.current) textareaRef.current.focus(); }, [open]);

  const handleConfirm = () => { onSave(draft.trim()); setOpen(false); };
  const handleCancel  = () => { setDraft(instruction); setOpen(false); };
  const handleClear   = () => { setDraft(""); onSave(""); setOpen(false); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { handleCancel(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleConfirm();
  };

  if (!open) {
    return (
      <button
        onClick={() => { setDraft(instruction); setOpen(true); }}
        className={cn(
          "group/gb w-full flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all duration-200",
          instruction.trim()
            ? "border-amber-500/60 bg-gradient-to-r from-amber-950/40 to-amber-900/20 hover:border-amber-400/80 shadow-[0_0_15px_-3px_rgba(245,158,11,0.15)] hover:shadow-[0_0_20px_-3px_rgba(245,158,11,0.25)]"
            : "border-dashed border-amber-800/40 bg-amber-950/10 hover:border-amber-600/60 hover:bg-amber-950/20",
        )}
      >
        <div className={cn(
          "flex items-center justify-center rounded-lg p-1.5",
          instruction.trim() ? "bg-amber-500/15" : "bg-slate-800/60 group-hover/gb:bg-amber-950/30",
        )}>
          <MessageSquarePlus className={cn(
            "h-4 w-4 shrink-0",
            instruction.trim() ? "text-amber-400" : "text-slate-500 group-hover/gb:text-amber-600",
          )} />
        </div>
        <div className="flex-1 min-w-0">
          {instruction.trim() ? (
            <>
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500 mb-0.5">Global Instruction</p>
              <p className="text-xs text-amber-300/80 truncate">{instruction}</p>
            </>
          ) : (
            <p className="text-xs text-slate-500 group-hover/gb:text-amber-600/80">
              <span className="font-bold">Global instruction</span>
              <span className="ml-1.5 opacity-70">— applied to every LLM call in the pipeline</span>
            </p>
          )}
        </div>
        <Pencil className={cn(
          "h-3.5 w-3.5 shrink-0 transition-opacity",
          instruction.trim()
            ? "text-amber-500/60 opacity-0 group-hover/gb:opacity-100"
            : "opacity-0 group-hover/gb:opacity-80 text-amber-600",
        )} />
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border-2 border-amber-500/50 bg-slate-900 overflow-hidden shadow-lg shadow-amber-900/10">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5 border-b border-amber-800/30 bg-amber-950/20">
        <MessageSquarePlus className="h-4 w-4 text-amber-400 shrink-0" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500">Global Instruction</p>
        <p className="text-[9px] text-amber-700/60 ml-auto">applied to every LLM call</p>
      </div>
      <FormatToolbar draft={draft} setDraft={setDraft} textareaRef={textareaRef} />
      <textarea
        ref={textareaRef}
        rows={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="E.g. 'Use concise British English. Always include a Definition of Done in every story.'"
        className="w-full resize-y bg-transparent px-3 py-2 text-xs text-amber-200/80 placeholder-slate-700 focus:outline-none leading-relaxed min-h-[80px]"
      />
      <div className="flex items-center justify-between border-t border-amber-900/30 bg-slate-900/60 px-3 py-1.5">
        <div className="flex items-center gap-3">
          {draft.trim() && (
            <button onClick={handleClear} className="flex items-center gap-0.5 text-[9px] text-slate-600 hover:text-red-400 transition-colors">
              <RotateCcw className="h-2.5 w-2.5" /> Clear
            </button>
          )}
          <span className="text-[9px] text-slate-700">{draft.length} chars · ⌘↵ save</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCancel} className="text-[9px] text-slate-600 hover:text-slate-400 transition-colors">Cancel</button>
          <button
            onClick={handleConfirm}
            className="flex items-center gap-1 rounded bg-amber-700/40 px-2.5 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-600/50 transition-colors"
          >
            <Check className="h-3 w-3" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Story Fields Editor — key-value pairs for additional fields in every story
// ─────────────────────────────────────────────────────────────────────────────

interface StoryFieldsEditorProps {
  fields: Record<string, string>;
  onChange: (fields: Record<string, string>) => void;
}

function StoryFieldsEditor({ fields, onChange }: StoryFieldsEditorProps) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Array<{ key: string; value: string }>>([]);

  const fieldCount = Object.keys(fields).length;

  const openEditor = () => {
    const entries = Object.entries(fields).map(([key, value]) => ({ key, value }));
    if (entries.length === 0) entries.push({ key: "", value: "" });
    setDrafts(entries);
    setOpen(true);
  };

  const handleSave = () => {
    const result: Record<string, string> = {};
    for (const { key, value } of drafts) {
      const k = key.trim().replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (k && value.trim()) result[k] = value.trim();
    }
    onChange(result);
    setOpen(false);
  };

  const handleCancel = () => setOpen(false);
  const handleClear = () => { onChange({}); setOpen(false); };

  const addRow = () => setDrafts((prev) => [...prev, { key: "", value: "" }]);
  const removeRow = (i: number) => setDrafts((prev) => prev.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: "key" | "value", val: string) =>
    setDrafts((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  if (!open) {
    return (
      <button
        onClick={openEditor}
        className={cn(
          "group/sf w-full flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all duration-200",
          fieldCount > 0
            ? "border-violet-500/60 bg-gradient-to-r from-violet-950/40 to-violet-900/20 hover:border-violet-400/80 shadow-[0_0_15px_-3px_rgba(139,92,246,0.15)] hover:shadow-[0_0_20px_-3px_rgba(139,92,246,0.25)]"
            : "border-dashed border-violet-800/40 bg-violet-950/10 hover:border-violet-600/60 hover:bg-violet-950/20",
        )}
      >
        <div className={cn(
          "flex items-center justify-center rounded-lg p-1.5",
          fieldCount > 0 ? "bg-violet-500/15" : "bg-slate-800/60 group-hover/sf:bg-violet-950/30",
        )}>
          <List className={cn(
            "h-4 w-4 shrink-0",
            fieldCount > 0 ? "text-violet-400" : "text-slate-500 group-hover/sf:text-violet-600",
          )} />
        </div>
        <div className="flex-1 min-w-0">
          {fieldCount > 0 ? (
            <>
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-500 mb-0.5">
                Story Fields ({fieldCount})
              </p>
              <p className="text-xs text-violet-300/80 truncate">
                {Object.keys(fields).join(", ")}
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500 group-hover/sf:text-violet-600/80">
              <span className="font-bold">Story fields</span>
              <span className="ml-1.5 opacity-70">— add custom key-value fields to every generated story</span>
            </p>
          )}
        </div>
        <Pencil className={cn(
          "h-3.5 w-3.5 shrink-0 transition-opacity",
          fieldCount > 0
            ? "text-violet-500/60 opacity-0 group-hover/sf:opacity-100"
            : "opacity-0 group-hover/sf:opacity-80 text-violet-600",
        )} />
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border-2 border-violet-500/50 bg-slate-900 overflow-hidden shadow-lg shadow-violet-900/10">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5 border-b border-violet-800/30 bg-violet-950/20">
        <List className="h-4 w-4 text-violet-400 shrink-0" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-violet-500">Story Fields</p>
        <p className="text-[9px] text-violet-700/60 ml-auto">key → description for each extra field in every story</p>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {drafts.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={row.key}
              onChange={(e) => updateRow(i, "key", e.target.value)}
              placeholder="field_name"
              className="w-[140px] rounded border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-violet-200/80 placeholder-slate-600 focus:outline-none focus:border-violet-600/60"
            />
            <span className="text-[10px] text-slate-600">→</span>
            <input
              type="text"
              value={row.value}
              onChange={(e) => updateRow(i, "value", e.target.value)}
              placeholder="Description of what this field should contain"
              className="flex-1 rounded border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-violet-200/80 placeholder-slate-600 focus:outline-none focus:border-violet-600/60"
            />
            <button onClick={() => removeRow(i)} className="text-slate-600 hover:text-red-400 transition-colors">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          onClick={addRow}
          className="flex items-center gap-1 text-[10px] text-violet-500/60 hover:text-violet-400 transition-colors"
        >
          <Plus className="h-3 w-3" /> Add field
        </button>
      </div>
      <div className="flex items-center justify-between border-t border-violet-900/30 bg-slate-900/60 px-3 py-1.5">
        <div className="flex items-center gap-3">
          {fieldCount > 0 && (
            <button onClick={handleClear} className="flex items-center gap-0.5 text-[9px] text-slate-600 hover:text-red-400 transition-colors">
              <RotateCcw className="h-2.5 w-2.5" /> Clear all
            </button>
          )}
          <span className="text-[9px] text-slate-700">{drafts.filter(r => r.key.trim()).length} field(s)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCancel} className="text-[9px] text-slate-600 hover:text-slate-400 transition-colors">Cancel</button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1 rounded bg-violet-700/40 px-2.5 py-1 text-[10px] font-semibold text-violet-300 hover:bg-violet-600/50 transition-colors"
          >
            <Check className="h-3 w-3" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Arrow connectors
// ─────────────────────────────────────────────────────────────────────────────

function Arrow({ dashed = false }: { dashed?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn(
        "w-px h-4 bg-slate-700",
        dashed && "border-l border-dashed border-slate-700 bg-transparent",
      )} />
      <svg width="8" height="5" viewBox="0 0 8 5" className="text-slate-600 -mt-px">
        <path d="M0 0 L4 5 L8 0" fill="currentColor" />
      </svg>
    </div>
  );
}

function MergeArrow() {
  return (
    <div className="flex flex-col items-center">
      <div className="w-px h-3 bg-slate-700" />
      <svg width="8" height="5" viewBox="0 0 8 5" className="text-slate-600 -mt-px">
        <path d="M0 0 L4 5 L8 0" fill="currentColor" />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout helpers
// ─────────────────────────────────────────────────────────────────────────────

function ParallelRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-center gap-3 w-full flex-wrap">
      {children}
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 w-full my-1">
      <div className="flex-1 h-px bg-slate-800" />
      <span className="text-[8px] uppercase tracking-widest text-slate-700 font-bold whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-slate-800" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend + counter
// ─────────────────────────────────────────────────────────────────────────────

function Legend({ noteCount }: { noteCount: number }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-4 rounded-full bg-emerald-500/70" />
        <span className="text-[10px] text-slate-500">Always runs</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-4 rounded-full bg-indigo-500/70" />
        <span className="text-[10px] text-slate-500">Enabled</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-4 rounded-full bg-slate-700/70" />
        <span className="text-[10px] text-slate-500">Skipped</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-4 rounded-full bg-amber-700/60" />
        <span className="text-[10px] text-amber-700/80">Customisable</span>
      </div>
      {noteCount > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-[10px] text-amber-500/70">{noteCount} instruction{noteCount > 1 ? "s" : ""} set</span>
        </div>
      )}
    </div>
  );
}

function StageCount({ active, total }: { active: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500">
        <span className="font-semibold text-slate-300">{active}</span>
        <span className="text-slate-600"> / {total} stages active</span>
      </span>
      <div className="h-1 rounded-full bg-slate-800 overflow-hidden w-20">
        <div
          className="h-full rounded-full bg-indigo-600 transition-all duration-300"
          style={{ width: `${(active / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function PipelineFlowchart({ config, instructions = {}, onInstructionChange, storyFields = {}, onStoryFieldsChange }: PipelineFlowchartProps) {
  const { useEpics, epicMode, useCode, useProject, useFigma, useStandards, quality } = config;

  const showGraphDb       = useCode;
  const showEpicGroup     = useEpics && epicMode === "epic_feature_story";
  const showAlreadyImpl   = useCode;
  const showCoverageRemed = quality !== "fast";

  const TOTAL_STAGES   = 18;
  // Core stages: 1, 2, 4, 9, 10, 11, 11.1, 11.5, 12, 14 = 10
  const activeOptional = [useCode, showGraphDb, useFigma, useProject, showEpicGroup, showAlreadyImpl, useStandards, showCoverageRemed].filter(Boolean).length;
  const activeStages   = 10 + activeOptional;
  const storyFieldCount = Object.keys(storyFields).length;
  const noteCount      = Object.values(instructions).filter((v) => v.trim()).length + (storyFieldCount > 0 ? 1 : 0);

  // helper to spread note props onto a StageNode
  const note = (id: string) => ({
    stageId: id,
    instruction: instructions[id] ?? "",
    onInstructionChange,
  });

  return (
    <div className="flex flex-col gap-1.5">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <Legend noteCount={noteCount} />
        <StageCount active={activeStages} total={TOTAL_STAGES} />
      </div>

      {/* Tip callout */}
      {onInstructionChange && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5">
          <span className="mt-px text-base leading-none">💡</span>
          <div className="space-y-0.5">
            <p className="text-[10px] font-semibold text-slate-400">Customise LLM behaviour at key stages</p>
            <p className="text-[10px] text-slate-600 leading-relaxed">
              The <span className="font-semibold text-amber-700">Global Instruction</span> below applies to every LLM call.
              For stage-level control, use the <span className="inline-flex items-center gap-0.5 rounded border border-dashed border-amber-900/50 bg-amber-950/10 px-1 py-px font-semibold text-amber-700"><Plus className="h-2.5 w-2.5" />Add instruction</span> button on:
              {" "}<span className="text-slate-500">Feature Extraction</span>, <span className="text-slate-500">Story Generation</span>, and <span className="text-slate-500">Standards Validation</span> — the stages where LLM reasoning shapes your output.
            </p>
          </div>
        </div>
      )}

      {/* Global instruction banner */}
      {onInstructionChange && (
        <GlobalBanner
          instruction={instructions["global"] ?? ""}
          onSave={(val) => onInstructionChange("global", val)}
        />
      )}

      {/* Story fields editor */}
      {onStoryFieldsChange && (
        <StoryFieldsEditor fields={storyFields} onChange={onStoryFieldsChange} />
      )}

      {/* ══ FLOW ══ */}
      <div className="flex flex-col items-center gap-0 mt-1">

        <SectionDivider label="Ingestion" />
        <StageNode
          stageNum="Stage 1" label="Document Intake" sub="Parse & chunk" variant="core"
          tooltip="Reads and normalises requirement docs (PDF, DOCX, CSV). Splits content into semantic chunks with hierarchical context (H1→H2→H3) and 20–30 % overlap for downstream retrieval."
        />
        <Arrow />

        <ParallelRow>
          <StageNode
            stageNum="Stage 2" label="Feature / Epic Extraction"
            sub={
              epicMode === "story_only"                     ? "Skipped — flat story list" :
              useEpics && epicMode === "epic_story"         ? "Mode: Epic \u2192 Story" :
              useEpics && epicMode === "epic_feature_story" ? "Mode: Epic \u2192 Feature \u2192 Story" :
              "Mode: Feature \u2192 Story"
            }
            variant={epicMode === "story_only" ? "skipped" : "core"}
            badge={epicMode === "story_only" ? "skipped" : undefined}
            tooltip="LLM scans the requirement chunks and extracts structured features (or Epics depending on mode). Groups related features, attaches metadata, and applies a classification-first approach for document-agnostic extraction."
            {...(epicMode !== "story_only" ? note("stage_2_feature_extraction") : {})}
          />
          <StageNode
            stageNum="Stage 4" label="Requirement VDB" sub="Embeddings + vector DB" variant="core"
            tooltip="Embeds all requirement chunks into a Postgres pgvector store. Enables hybrid semantic + keyword retrieval during story generation so every claim can be traced back to source."
          />
        </ParallelRow>
        <Arrow />

        <SectionDivider label="Context Enrichment (optional)" />
        <Arrow dashed />

        <ParallelRow>
          <div className="flex flex-col items-center gap-0">
            <StageNode
              stageNum="Stage 5" label="Code Context" sub="Pre-indexed repo"
              variant={useCode ? "active" : "skipped"}
              badge={useCode ? undefined : "skipped"}
              tooltip="AST-parses the codebase and extracts functions, classes, API endpoints and DB entities (50–250 tokens each) with rich metadata. Enables the LLM to reference real implementation details in generated stories."
            />
            {showGraphDb && (
              <>
                <Arrow />
                <StageNode
                  stageNum="Stage 7" label="Graph DB" sub="Dependency graph" variant="active"
                  tooltip="Builds a directed dependency graph from code: file→function, function→function (calls), imports, API publish/read, DB read/write edges. Used by Story Generation for impact-aware context retrieval."
                />
              </>
            )}
          </div>
          <StageNode
            stageNum="Stage 6" label="Figma Context" sub="Design files"
            variant={useFigma ? "active" : "skipped"}
            badge={useFigma ? undefined : "skipped"}
            tooltip="Connects to the Figma API and converts components, frames and layout annotations into searchable text descriptions embedded in the vector store. Grounds UI stories in actual design intent."
          />
          <StageNode
            stageNum="Stage 8" label="Project Context" sub="Architecture / ADR docs"
            variant={useProject ? "active" : "skipped"}
            badge={useProject ? undefined : "skipped"}
            tooltip="Reads README, architecture docs, docker-compose, package.json and .env.example. Chunks by section heading and embeds them. Gives the LLM awareness of tech stack, architecture patterns and ADR decisions."
          />
        </ParallelRow>

        <MergeArrow />
        <SectionDivider label="Generation" />
        <Arrow />

        <StageNode
          stageNum="Stage 9" label="Story Generation" sub="LLM + hybrid search" variant="core"
          tooltip="Core generation step. Per-feature hybrid search (vector + keyword) retrieves the most relevant requirement, code, Figma and project chunks. The LLM then produces INVEST-compliant user stories with acceptance criteria and implementation hints."
          {...note("stage_9_story_generation")}
        />
        <Arrow />

        <SectionDivider label="Quality & Refinement" />
        <Arrow />

        <StageNode
          stageNum="Stage 10" label="Hallucination Detection" sub="Detect & auto-fix" variant="core"
          tooltip="Cross-checks every generated story claim against source chunks. Validates citations exist, verifies business rules and code references, scores hallucination risk and flags any unsupported assertions for automatic correction."
        />
        <Arrow />
        <StageNode
          stageNum="Stage 11" label="Self-Refinement" sub="Quality improvement" variant="core"
          tooltip="Rule-based quality pass: checks field completeness, duplicate detection and conflict resolution. Fills missing fields, enforces minimum AC/BR counts and resolves inconsistencies across stories."
        />
        <Arrow />
        <StageNode
          stageNum="Stage 11.6" label="Coverage Remediation"
          sub={showCoverageRemed ? "Fill requirement gaps" : "Skipped in fast mode"}
          variant={showCoverageRemed ? "active" : "skipped"}
          badge={showCoverageRemed ? undefined : "skipped"}
          tooltip="Detects requirement chunks not adequately covered by existing stories using semantic similarity scoring against a quality-level threshold (standard=0.60, high=0.70). Generates gap-filling stories with full citation metadata and assigns them to the appropriate feature/epic."
        />
        <Arrow dashed={!showCoverageRemed} />
        <StageNode
          stageNum="Stage 11.1" label="Duplicate Detection" sub="Merge similar stories" variant="core"
          tooltip="Combines semantic embedding similarity, fuzzy text matching and entity overlap analysis to identify near-identical stories generated across different features. Merges or discards duplicates to keep the output clean."
        />
        <Arrow />

        <ParallelRow>
          <StageNode
            stageNum="Stage 11.15" label="Epic Grouping"
            sub={showEpicGroup ? "Group features → epics" : "3-level hierarchy only"}
            variant={showEpicGroup ? "active" : "skipped"}
            badge={showEpicGroup ? undefined : "skipped"}
            tooltip="Groups generated features and stories under parent epics according to the Epic→Feature→Story hierarchy defined in Stage 2. Only active in epic_feature_story mode."
          />
          <StageNode
            stageNum="Stage 11.2" label="Already Implemented" sub="Code coverage check"
            variant={showAlreadyImpl ? "active" : "skipped"}
            badge={showAlreadyImpl ? undefined : "skipped"}
            tooltip="Scans code context for existing functions, API endpoints and DB entities that match each story's scope. Tags stories as fully or partially implemented to avoid redundant work."
          />
        </ParallelRow>

        <MergeArrow />
        <StageNode
          stageNum="Stage 11.5" label="Relationship Detection" sub="Inter-story links" variant="core"
          tooltip="Uses keyword detection, code graph analysis and LLM inference to populate JIRA link types: BLOCKS/BLOCKED\_BY, PARENT\_OF/CHILD\_OF and RELATED. Stories sharing code files or features are automatically linked."
        />
        <Arrow />

        <SectionDivider label="Output" />
        <Arrow />

        <StageNode
          stageNum="Stage 12" label="Entity Linking" sub="Build entity graph" variant="core"
          tooltip="Builds the complete cross-reference graph: Feature↔Story, Story↔Business Rule, Story↔Acceptance Criteria, Story↔Story (relationships) and Story↔Code. Enables full traceability from requirement to implementation."
        />
        <Arrow />

        <StageNode
          stageNum="Stage 13" label="Standards Validation"
          sub={useStandards ? config.stdTypes.join(", ") : "TMForum eTOM / SID"}
          variant={useStandards ? "active" : "skipped"}
          badge={useStandards ? undefined : "skipped"}
          tooltip="Validates stories against selected industry frameworks (TMForum eTOM/SID, ISO, PCI-DSS). Performs semantic entity matching, compliance scoring and generates [TMF-XXX] citation references for traceability."
          {...note("stage_13_standards_validation")}
        />
        <Arrow dashed={!useStandards} />

        <StageNode
          stageNum="Stage 14" label="Final JIRA Output" sub="JIRA-ready artifacts" variant="core"
          tooltip="Assembles the final JSON bundle: all features and stories, entity links, relationship graph, traceability maps, quality metrics and run statistics — ready to push directly to JIRA."
        />
      </div>
    </div>
  );
}

