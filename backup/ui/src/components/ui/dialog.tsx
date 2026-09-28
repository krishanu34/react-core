"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Lightweight Dialog / Modal built on <dialog> — no extra deps      */
/* ------------------------------------------------------------------ */

interface DialogContextValue {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const DialogContext = React.createContext<DialogContextValue>({
  open: false,
  setOpen: () => {},
});

/* ---------- root wrapper ---------- */

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open: controlledOpen, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = React.useCallback(
    (v: React.SetStateAction<boolean>) => {
      const next = typeof v === "function" ? v(open) : v;
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [open, isControlled, onOpenChange],
  );

  return (
    <DialogContext.Provider value={{ open, setOpen }}>
      {children}
    </DialogContext.Provider>
  );
}

/* ---------- trigger ---------- */

export const DialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ onClick, children, ...props }, ref) => {
  const { setOpen } = React.useContext(DialogContext);
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      onClick={(e) => {
        setOpen(true);
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
});
DialogTrigger.displayName = "DialogTrigger";

/* ---------- overlay + content ---------- */

export function DialogContent({
  children,
  className = "",
  disableBackdropClose = false,
  disableEscapeClose = false,
  hideCloseButton = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** When true, clicking the backdrop will NOT close the dialog. */
  disableBackdropClose?: boolean;
  /** When true, pressing Escape will NOT close the dialog. */
  disableEscapeClose?: boolean;
  /** When true, the default X close button in the top-right corner is hidden.
   *  Use this when the dialog content manages its own close button. */
  hideCloseButton?: boolean;
}) {
  const { open, setOpen } = React.useContext(DialogContext);

  // close on Escape
  React.useEffect(() => {
    if (!open || disableEscapeClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, disableEscapeClose, setOpen]);

  // prevent body scroll when open
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={disableBackdropClose ? undefined : () => setOpen(false)}
      />
      {/* panel */}
      <div
        className={cn(
          "relative z-10 w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl animate-in fade-in",
          className
        )}
      >
        {/* close button */}
        {!hideCloseButton && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 rounded-md p-1 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        )}
        {children}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/* ---------- header ---------- */

export function DialogHeader({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={"mb-4 space-y-1.5 " + className}>{children}</div>;
}

/* ---------- title ---------- */

export function DialogTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h2 className={"text-lg font-semibold text-slate-100 " + className}>{children}</h2>;
}

/* ---------- description ---------- */

export function DialogDescription({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={"text-sm text-slate-400 " + className}>{children}</p>;
}

/* ---------- footer ---------- */

export function DialogFooter({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"mt-6 flex items-center justify-end gap-3 border-t border-slate-700/60 pt-4 " + className}>
      {children}
    </div>
  );
}