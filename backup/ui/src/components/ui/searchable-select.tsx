"use client";

import {
  useState,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { Search, Check, ChevronsUpDown, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface SearchableOption {
  /** Unique value for this option (string) */
  value: string;
  /** Primary display label */
  label: string;
  /** Optional secondary text shown to the right / below */
  sublabel?: string;
  /** Optional icon or badge shown before the label */
  icon?: ReactNode;
}

export interface SearchableSelectProps {
  /** Full list of options to render */
  options: SearchableOption[];
  /** Currently-selected value (empty string = nothing selected) */
  value: string;
  /** Called when the user picks an option */
  onChange: (value: string) => void;
  /** Text on the trigger when nothing is selected */
  placeholder?: string;
  /** Placeholder inside the search input */
  searchPlaceholder?: string;
  /** Shown when the search yields no matches */
  emptyMessage?: string;
  /** Extra classes applied to the trigger button (e.g. width) */
  className?: string;
  /** If true, an "All" option with value "" is prepended */
  allowAll?: boolean;
  /** Label for the "All" option (default "All") */
  allLabel?: string;
  /** Disable the control */
  disabled?: boolean;
  /** Label for a sticky "create" footer button shown at the bottom of the dropdown */
  actionLabel?: string;
  /** Called when the footer action button is clicked */
  onAction?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No results.",
  className,
  allowAll = false,
  allLabel = "All",
  disabled = false,
  actionLabel,
  onAction,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---- Outside-click to close ---- */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  /* ---- Focus search when opened, clear when closed ---- */
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setSearch("");
    }
  }, [open]);

  /* ---- Filtered options ---- */
  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel && o.sublabel.toLowerCase().includes(q)),
    );
  }, [options, search]);

  /* ---- Display label ---- */
  const selected = options.find((o) => o.value === value);
  const triggerLabel =
    value === "" && allowAll
      ? allLabel
      : selected
        ? selected.label
        : placeholder;

  const handlePick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border px-3 py-2 text-sm",
          "bg-slate-800 border-slate-700 text-slate-100",
          "hover:bg-slate-700/50 transition-colors",
          "focus:outline-none focus:ring-1 focus:ring-slate-500",
          disabled && "opacity-50 cursor-not-allowed",
          !selected && !(value === "" && allowAll) && "text-slate-400",
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-slate-500" />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-full rounded-md border border-slate-700",
            "bg-slate-800 shadow-lg shadow-black/40",
            "animate-in fade-in-0 zoom-in-95 duration-100",
          )}
        >
          {/* Search bar */}
          <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
            <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
            <input
              ref={searchRef}
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-slate-500 hover:text-slate-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Scrollable option list */}
          <div className="max-h-52 overflow-y-auto overscroll-contain py-1">
            {/* "All" option */}
            {allowAll && (
              <>
                <button
                  type="button"
                  onClick={() => handlePick("")}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                    "hover:bg-slate-700/60",
                    value === "" ? "text-slate-100" : "text-slate-300",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      value === "" ? "text-indigo-400" : "text-transparent",
                    )}
                  />
                  <span className="font-medium">{allLabel}</span>
                </button>
                {filtered.length > 0 && (
                  <div className="mx-2 my-1 border-t border-slate-700/60" />
                )}
              </>
            )}

            {/* Options */}
            {filtered.length === 0 && search.trim() ? (
              <p className="px-3 py-3 text-xs text-slate-500 text-center">
                {emptyMessage}
              </p>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handlePick(opt.value)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                    "hover:bg-slate-700/60",
                    value === opt.value ? "text-slate-100" : "text-slate-300",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      value === opt.value
                        ? "text-indigo-400"
                        : "text-transparent",
                    )}
                  />
                  {opt.icon && (
                    <span className="shrink-0">{opt.icon}</span>
                  )}
                  <span className="font-medium truncate flex-1 text-left">
                    {opt.label}
                  </span>
                  {opt.sublabel && (
                    <span className="text-xs text-slate-400 shrink-0">
                      {opt.sublabel}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Optional sticky footer action (e.g. "Create new project") */}
          {actionLabel && onAction && (
            <>
              <div className="mx-2 border-t border-slate-700/60" />
              <button
                type="button"
                onClick={() => { onAction(); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-indigo-400 hover:bg-slate-700/60 transition-colors"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">{actionLabel}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
