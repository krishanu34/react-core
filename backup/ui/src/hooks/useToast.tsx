"use client";

import React, { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev.slice(-4), { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const iconMap = {
    success: <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />,
    error: <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />,
    info: <Info className="w-3.5 h-3.5 text-cbv2-accent shrink-0 mt-0.5" />,
  };

  const borderMap = {
    success: "border-green-800/60 bg-green-950/40",
    error: "border-red-800/60 bg-red-950/40",
    info: "border-cbv2-accent/40 bg-cbv2-accent/5",
  };

  const textMap = {
    success: "text-green-300",
    error: "text-red-300",
    info: "text-cbv2-text",
  };

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-10 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-lg border text-[11px] min-w-[260px] max-w-[380px] cbv2-card-elevated cbv2-animate-scale-in ${borderMap[t.type]}`}
            >
              {iconMap[t.type]}
              <span className={`flex-1 break-words leading-relaxed ${textMap[t.type]}`}>
                {t.message}
              </span>
              <button
                className="shrink-0 p-0.5 rounded hover:bg-white/10 text-cbv2-text-dim hover:text-white transition-colors"
                onClick={() => removeToast(t.id)}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
