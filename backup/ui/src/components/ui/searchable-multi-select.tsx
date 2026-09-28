"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Search, ChevronsUpDown, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface SearchableMultiSelectProps {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  /** Max number of labels shown as chips before showing "+ N more" */
  maxChips?: number;
}

export function SearchableMultiSelect({
  options,
  values,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No results.",
  className,
  disabled = false,
  maxChips = 3,
}: SearchableMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setSearch("");
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.sublabel && o.sublabel.toLowerCase().includes(q))
    );
  }, [options, search]);

  const toggle = (val: string) => {
    onChange(values.includes(val) ? values.filter((v) => v !== val) : [...values, val]);
  };

  const remove = (val: string) => {
    onChange(values.filter((v) => v !== val));
  };

  const selectedOptions = values.map((v) => options.find((o) => o.value === v)).filter(Boolean) as MultiSelectOption[];
  const visible = selectedOptions.slice(0, maxChips);
  const overflow = selectedOptions.length - maxChips;

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex min-h-9 w-full items-center justify-between rounded-md border px-3 py-1.5 text-sm",
          "bg-slate-800 border-slate-700 text-slate-100",
          "hover:bg-slate-700/50 transition-colors",
          "focus:outline-none focus:ring-1 focus:ring-indigo-500",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className="flex flex-wrap gap-1 flex-1 min-w-0">
          {selectedOptions.length === 0 ? (
            <span className="text-slate-400">{placeholder}</span>
          ) : (
            <>
              {visible.map((o) => (
                <span
                  key={o.value}
                  className="inline-flex items-center gap-1 rounded bg-indigo-600/30 border border-indigo-500/30 px-1.5 py-0.5 text-xs text-indigo-200"
                >
                  {o.label}
                  <span
                    role="button"
                    aria-label={`Remove ${o.label}`}
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); remove(o.value); }}
                    className="text-indigo-400 hover:text-white cursor-pointer"
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
                </span>
              ))}
              {overflow > 0 && (
                <span className="inline-flex items-center rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                  +{overflow} more
                </span>
              )}
            </>
          )}
        </span>
        <span className="flex items-center gap-1 ml-2 shrink-0">
          {values.length > 0 && (
            <span
              role="button"
              aria-label="Clear all"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChange([]); }}
              className="text-slate-500 hover:text-slate-300 p-0.5 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronsUpDown className="h-3.5 w-3.5 text-slate-500" />
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className={cn(
          "absolute z-50 mt-1 w-full rounded-md border border-slate-700",
          "bg-slate-800 shadow-lg shadow-black/40",
          "animate-in fade-in-0 zoom-in-95 duration-100",
        )}>
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
              <button type="button" onClick={() => setSearch("")} className="text-slate-500 hover:text-slate-300">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Select all / clear row */}
          {options.length > 1 && (
            <div className="flex items-center justify-between border-b border-slate-700/50 px-3 py-1.5 text-[10px] text-slate-500">
              <button
                type="button"
                onClick={() => onChange(options.map((o) => o.value))}
                className="hover:text-indigo-400 transition-colors"
              >
                Select all
              </button>
              {values.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="hover:text-red-400 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          {/* Option list */}
          <div className="max-h-56 overflow-y-auto overscroll-contain py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500 text-center">{emptyMessage}</p>
            ) : (
              filtered.map((opt) => {
                const checked = values.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left",
                      "hover:bg-slate-700/60",
                      checked ? "text-slate-100" : "text-slate-300",
                    )}
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      checked
                        ? "border-indigo-500 bg-indigo-600"
                        : "border-slate-600 bg-slate-800",
                    )}>
                      {checked && <Check className="h-2.5 w-2.5 text-white" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{opt.label}</span>
                      {opt.sublabel && (
                        <span className="block text-xs text-slate-500 truncate">{opt.sublabel}</span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
