"use client";

/**
 * Shared form and layout primitives for the admin and usage pages.
 *
 * These exist because the first version of those pages got two things wrong,
 * and both were the kind of mistake that repeats itself once per page:
 *
 *  1. **Native `<select>`.** The browser draws the option list using the OS's
 *     own light colours, but the options inherit the app's light text colour —
 *     so every value was white-on-white and only legible under the hover
 *     highlight. Native selects can't be reliably themed; this wraps the
 *     project's Radix `Select`, whose list is real DOM we control.
 *
 *  2. **Undefined utility classes.** They used shadcn's semantic names
 *     (`text-muted-foreground`, `bg-muted`, plain `border`), which this project
 *     never defines — `globals.css` has no `--color-muted-foreground`, and
 *     `Card` / `PageHeader` use explicit `slate-*`. Those classes rendered as
 *     nothing, which is why the pages looked washed out.
 *
 * The palette here is the one the rest of the app uses: `slate-900` surfaces on
 * a `slate-950` shell, `slate-800` for raised rows and inputs, `slate-700`
 * borders, `slate-100` primary text, `slate-400` secondary, violet for accent
 * and selection.
 */

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ── Text inputs ──────────────────────────────────────────────────────────────

const inputBase =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 " +
  "placeholder:text-slate-500 outline-none transition-colors " +
  "focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(inputBase, className)} {...props} />
));
TextInput.displayName = "TextInput";

/** A labelled field. `hint` carries the "why", which most of these need. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="block text-xs font-medium text-slate-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-slate-500">{hint}</p>}
    </div>
  );
}

// ── Dropdown ─────────────────────────────────────────────────────────────────

export interface DropdownOption {
  value: string;
  label: string;
  /** Secondary line, e.g. an email under a username. */
  detail?: string;
}

/**
 * A themed dropdown.
 *
 * Radix reserves `""` for "clear the selection", so an empty value can't be a
 * real item. That is why the unselected state is a `placeholder` rather than a
 * `<SelectItem value="">Select…</SelectItem>` — the shape the native version
 * used, and the shape that would silently break here.
 */
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={cn(
          "h-9 rounded-lg border-slate-700 bg-slate-800 text-slate-100",
          "focus:ring-violet-500/30 data-[placeholder]:text-slate-500",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="border-slate-700 bg-slate-800">
        {options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">Nothing to choose from</div>
        ) : (
          options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              className="text-slate-200 focus:bg-violet-600/25 focus:text-violet-100"
            >
              <span>{o.label}</span>
              {o.detail && <span className="ml-2 text-xs text-slate-500">{o.detail}</span>}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium " +
  "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const buttonTone = {
  primary: "bg-violet-600 text-white hover:bg-violet-500",
  ghost: "border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white",
  danger: "border border-slate-700 bg-slate-800 text-red-400 hover:border-red-500/50 hover:bg-red-500/10",
} as const;

const buttonSize = {
  sm: "h-7 px-2 text-xs",
  md: "h-9 px-3",
} as const;

export function Button({
  tone = "ghost",
  size = "md",
  busy,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: keyof typeof buttonTone;
  size?: keyof typeof buttonSize;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(buttonBase, buttonTone[tone], buttonSize[size], className)}
      disabled={props.disabled || busy}
      {...props}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/** Square icon-only button, for the delete affordance on dense rows. */
export function IconButton({
  tone = "ghost",
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof buttonTone }) {
  return (
    <button
      type="button"
      className={cn(buttonBase, buttonTone[tone], "h-7 w-7 shrink-0 p-0", className)}
      {...props}
    >
      {children}
    </button>
  );
}

// ── Small display pieces ─────────────────────────────────────────────────────

const pillTone = {
  neutral: "bg-slate-800 text-slate-300 ring-slate-700",
  accent: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  good: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  bad: "bg-red-500/15 text-red-300 ring-red-500/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
} as const;

export function Pill({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof pillTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        pillTone[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A short explanation attached to a control, in the tone of the thing it says. */
export function Note({
  tone = "info",
  className,
  children,
}: {
  tone?: "info" | "warn" | "neutral";
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-sky-500/25 bg-sky-500/5 text-sky-200/90",
    warn: "border-amber-500/25 bg-amber-500/5 text-amber-200/90",
    neutral: "border-slate-800 bg-slate-900/60 text-slate-400",
  };
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-xs leading-relaxed", tones[tone], className)}>
      {children}
    </p>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </p>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-800 py-8 text-center">
      <Icon className="h-6 w-6 text-slate-600" />
      <p className="text-sm text-slate-300">{title}</p>
      {hint && <p className="max-w-md text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center gap-2 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn(
        "border-b border-slate-800 py-2 text-xs font-medium text-slate-400",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right,
  mono,
  dim,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
  dim?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-slate-800/60 py-2",
        right && "text-right",
        mono && "font-mono tabular-nums",
        dim ? "text-slate-500" : "text-slate-200",
      )}
    >
      {children}
    </td>
  );
}

/** A dense, hoverable row used for the list-of-things sections. */
export function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3",
        "transition-colors hover:border-slate-700 hover:bg-slate-800/60",
        className,
      )}
    >
      {children}
    </div>
  );
}
