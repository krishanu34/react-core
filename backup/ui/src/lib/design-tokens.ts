/**
 * design-tokens — Modernization Studio theme tokens for the new IDE module.
 *
 * ADDITIVE ONLY. This is a new file; it does not modify the existing
 * code-builder-v2/theme-store.ts or components/ui/*. The new IDE components
 * consume these tokens so colour / spacing / typography stay consistent.
 *
 * Values are plain Tailwind class fragments / CSS values so components can use
 * them without a runtime theme provider.
 */

export const ideColors = {
  bg: "#0b0f1a",
  surface: "#111827",
  surfaceRaised: "#1f2937",
  border: "#334155",
  borderSubtle: "#1e293b",
  accent: "#7c3aed",
  accentHover: "#8b5cf6",
  text: "#e5e7eb",
  textMuted: "#94a3b8",
  state: {
    success: "#059669",
    warn: "#d97706",
    error: "#dc2626",
    info: "#2563eb",
  },
} as const;

export const ideSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const ideRadius = {
  sm: "4px",
  md: "6px",
  lg: "10px",
} as const;

export const ideTypography = {
  ui: { fontFamily: "Inter, Calibri, system-ui, sans-serif", size: 13 },
  editor: { fontFamily: "Consolas, 'Fira Code', monospace", size: 13 },
} as const;

/** Tailwind class presets (CSS-variable based so they re-theme live). */
export const ideClasses = {
  panel: "bg-[var(--ide-surface)] border border-[var(--ide-border)] rounded-md",
  panelHeader:
    "flex items-center justify-between h-8 px-2 text-xs font-medium text-[var(--ide-text)] " +
    "bg-[var(--ide-surface-2)] border-b border-[var(--ide-border)] select-none",
  iconButton:
    "inline-flex items-center justify-center h-6 w-6 rounded hover:bg-[var(--ide-hover)] " +
    "text-[var(--ide-muted)] hover:text-[var(--ide-text)] transition-colors",
  activityIcon:
    "flex items-center justify-center h-11 w-11 text-[var(--ide-muted)] hover:text-[var(--ide-text)] " +
    "border-l-2 border-transparent transition-colors",
  activityIconActive: "text-[var(--ide-text)] border-l-2 border-[var(--ide-accent)] bg-[var(--ide-surface-2)]",
  statusItem: "inline-flex items-center gap-1 px-2 h-full text-[11px] text-[var(--ide-text)]",
} as const;

/**
 * IDE theme palettes. Returned as a CSS-variable map applied to the IDE root
 * container's `style`; every component reads `var(--ide-*)`, so toggling the
 * theme re-skins the ENTIRE workspace at once (point 3 / theme switching).
 */
const IDE_DARK: Record<string, string> = {
  "--ide-bg": "#16161a",
  "--ide-surface": "#1a1a2e",
  "--ide-surface-2": "#22223a",
  "--ide-border": "rgba(255,255,255,0.08)",
  "--ide-text": "#e2e8f0",
  "--ide-muted": "#94a3b8",
  "--ide-hover": "rgba(255,255,255,0.06)",
  "--ide-accent": "#7c3aed",
  "--ide-glass": "rgba(26,26,46,0.65)",
  "--ide-glass-border": "rgba(255,255,255,0.06)",
  "--ide-gradient-from": "#7c3aed",
  "--ide-gradient-to": "#4f46e5",
};
const IDE_LIGHT: Record<string, string> = {
  "--ide-bg": "#f3f4f6",
  "--ide-surface": "#ffffff",
  "--ide-surface-2": "#e9eaed",
  "--ide-border": "rgba(0,0,0,0.12)",
  "--ide-text": "#1a1a2e",
  "--ide-muted": "#6b7280",
  "--ide-hover": "rgba(227,25,55,0.07)",
  "--ide-accent": "#e31937",
  "--ide-glass": "rgba(255,255,255,0.92)",
  "--ide-glass-border": "rgba(0,0,0,0.08)",
  "--ide-gradient-from": "#e31937",
  "--ide-gradient-to": "#b91430",
};

export function ideThemeVars(theme: "dark" | "light"): Record<string, string> {
  return theme === "light" ? IDE_LIGHT : IDE_DARK;
}
