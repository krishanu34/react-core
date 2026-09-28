"use client";

import * as React from "react";

/* ------------------------------------------------------------------ */
/*  Lightweight controlled Tabs – polished underline variant           */
/* ------------------------------------------------------------------ */

interface TabsContextValue {
  value: string;
  onValueChange: (v: string) => void;
}

const TabsCtx = React.createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = React.useContext(TabsCtx);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
  return ctx;
}

/* ---- root -------------------------------------------------------- */

interface TabsProps {
  value: string;
  onValueChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const ctx = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange]);
  return (
    <TabsCtx.Provider value={ctx}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  );
}

/* ---- list -------------------------------------------------------- */

export function TabsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={
        className ??
        "flex items-center gap-0 border-b border-slate-700/60"
      }
    >
      {children}
    </div>
  );
}

/* ---- trigger ----------------------------------------------------- */

interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function TabsTrigger({ value, children, className }: TabsTriggerProps) {
  const { value: active, onValueChange } = useTabs();
  const isActive = active === value;
  const baseClass = [
    "relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 rounded-t-md",
    isActive
      ? "text-white"
      : "text-slate-400 hover:text-slate-200",
    /* bottom indicator */
    isActive
      ? "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-indigo-500 after:rounded-full"
      : "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-transparent",
  ].join(" ");
  return (
    <button
      role="tab"
      aria-selected={isActive}
      data-state={isActive ? "active" : "inactive"}
      onClick={() => onValueChange(value)}
      className={className ? `${baseClass} ${className}` : baseClass}
    >
      {children}
    </button>
  );
}

/* ---- content ----------------------------------------------------- */

interface TabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  const { value: active } = useTabs();
  if (active !== value) return null;
  return <div className={className}>{children}</div>;
}
