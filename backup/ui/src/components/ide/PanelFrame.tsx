"use client";

/**
 * PanelFrame — reusable panel chrome with VS Code / Figma-style window controls.
 *
 * ISOLATION: new file under components/ide/. Provides header + minimize /
 * maximize / restore / close. Layout state can be persisted by the parent via
 * the onChange callback (stored in IndexedDB 'prefs').
 */
import React, { useState } from "react";
import { Minus, Minimize2, X, Maximize2 } from "lucide-react";
import { ideClasses } from "@/lib/design-tokens";

export interface PanelState {
  collapsed?: boolean;
  maximized?: boolean;
}

/* ========================================================================== *
 *  PanelFrame — panel chrome with minimize / maximize / restore / close
 * ========================================================================== */
export function PanelFrame({
  title,
  icon,
  actions,
  children,
  state,
  onChange,
  onClose,
  className = "",
}: {
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  state?: PanelState;
  onChange?: (next: PanelState) => void;
  onClose?: () => void;
  className?: string;
}) {
  const [local, setLocal] = useState<PanelState>(state ?? {});
  const s = state ?? local;

  const update = (next: PanelState) => {
    const merged = { ...s, ...next };
    setLocal(merged);
    onChange?.(merged);
  };

  return (
    <section
      className={`flex flex-col min-h-0 min-w-0 bg-[var(--ide-glass)] backdrop-blur-md border border-[var(--ide-glass-border)] rounded-xl shadow-lg ${
        s.maximized ? "fixed top-14 left-2 right-2 bottom-2 z-40" : "h-full"
      } ${className}`}
    >
      <header className={ideClasses.panelHeader}>
        <div className="flex items-center gap-1.5 truncate">
          {icon}
          <span className="uppercase tracking-wide text-[11px] truncate">{title}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {actions}
          <button
            type="button"
            title={s.collapsed ? "Expand" : "Minimize"}
            className={ideClasses.iconButton}
            onClick={() => update({ collapsed: !s.collapsed })}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={s.maximized ? "Restore" : "Maximize"}
            className={ideClasses.iconButton}
            onClick={() => update({ maximized: !s.maximized })}
          >
            {s.maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          {onClose && (
            <button type="button" title="Close" className={ideClasses.iconButton} onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>
      {!s.collapsed && <div className="flex-1 min-h-0 min-w-0 overflow-auto">{children}</div>}
    </section>
  );
}

export default PanelFrame;
