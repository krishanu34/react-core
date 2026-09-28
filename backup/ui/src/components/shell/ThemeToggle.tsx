"use client";

/**
 * ThemeToggle — the single dark/light switch for the whole product.
 *
 * Rendered in the app chrome (DevSphereShell header) and on the signed-out
 * pages, which have no chrome of their own. Flipping it re-themes every
 * surface at once, including the workspace IDE — see lib/theme.ts.
 */
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { toggleTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  // The real theme comes from localStorage, so the server render can't know it.
  // Render the icon only after mount to keep the markup consistent; the page
  // itself is already painted correctly by the pre-paint script.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800",
        "text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
        className,
      )}
    >
      {mounted && theme === "light" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </button>
  );
}
