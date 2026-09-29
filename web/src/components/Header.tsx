"use client";

import { Settings } from "lucide-react";
import { useState } from "react";
import { BellLogo } from "./BellLogo";
import { SettingsModal } from "./SettingsModal";

const NAV = ["Conversations", "Artefacts", "Knowledge", "Docs"];

export function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="bell-gradient sticky top-0 z-20 border-b border-white/10 text-white shadow-[0_2px_12px_rgba(0,61,130,0.25)]">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <BellLogo />

        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 text-sm font-medium md:flex"
        >
          {NAV.map((item, i) => (
            <a
              key={item}
              href="#"
              aria-current={i === 0 ? "page" : undefined}
              className={
                i === 0
                  ? "rounded-[var(--radius-bell-pill)] bg-white/15 px-3 py-1.5 text-white"
                  : "rounded-[var(--radius-bell-pill)] px-3 py-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              }
            >
              {item}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-[var(--radius-bell-pill)] bg-white/12 px-3 py-1.5 text-xs font-medium text-white/90 sm:flex">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Agent ready
          </span>

          <button
            type="button"
            aria-label="Open settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
          >
            <Settings size={18} aria-hidden />
          </button>

          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-sm font-semibold text-bell-blue shadow-sm ring-2 ring-white/30"
            title="Admin"
          >
            A
          </span>
        </div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
