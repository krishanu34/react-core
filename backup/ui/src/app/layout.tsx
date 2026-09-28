import type { Metadata } from "next";
import { DevSphereShell } from "@/components/shell/DevSphereShell";
import QueryProvider from "@/lib/QueryProvider";
import { LaunchModeProvider } from "@/providers/LaunchModeProvider";
import { cn } from "@/lib/utils";
import "./globals.css";

// We previously loaded Inter via next/font/google. That fetches the
// font CSS from fonts.googleapis.com at build time \u2014 which fails on
// build hosts without outbound internet (CI, locked-down deploys) and
// kills the entire build. Use a system-font stack instead so the build
// is fully offline-safe; the look stays clean across OSes.
const SYSTEM_FONT_CLASS = "font-sans";

export const metadata: Metadata = {
  title: "DevSphere AI",
  description: "AI coding assistant — open a workspace and build.",
};

/**
 * Applies the saved theme BEFORE first paint, so the page never flashes dark
 * and then turns light (localStorage is not readable during SSR). Must stay in
 * sync with applyTheme() in lib/theme.ts — that is the runtime path; this is
 * the same rules inlined for the very first frame.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem("devsphere:theme");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    var r = document.documentElement;
    r.classList.toggle("dark", theme === "dark");
    r.classList.toggle("light", theme === "light");
    r.setAttribute("data-theme", theme);
    r.setAttribute("data-cbv2-theme", theme);
    r.setAttribute("data-ide-theme", theme);
    r.style.colorScheme = theme;
  } catch (e) { /* keep the server-rendered dark default */ }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: browser extensions (Grammarly, ColorZilla, dark
    // readers, password managers) commonly inject attributes onto <html>/<body>
    // before React hydrates, which React 19 reports as hydration error #418.
    // This only suppresses the warning one level deep (the element it's on), so
    // genuine mismatches inside the app tree are still surfaced.
    // className/data-theme are the server-side dark default; THEME_BOOTSTRAP
    // rewrites them from localStorage before the first paint.
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body
        className={cn(SYSTEM_FONT_CLASS, "bg-background text-foreground antialiased")}
        suppressHydrationWarning
      >
        <QueryProvider>
          <LaunchModeProvider>
            <DevSphereShell>{children}</DevSphereShell>
          </LaunchModeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
