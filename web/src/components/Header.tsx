"use client";

import { Settings } from "lucide-react";
import { useState } from "react";
import { BellLogo } from "./BellLogo";
import { SettingsModal } from "./SettingsModal";

export function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 border-b border-bell-blue-dark bg-bell-blue text-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <BellLogo />

        <nav
          aria-label="Primary"
          className="hidden items-center gap-6 text-sm font-medium text-white/85 md:flex"
        >
          <a className="hover:text-white" href="#">
            Conversations
          </a>
          <a className="hover:text-white" href="#">
            Artefacts
          </a>
          <a className="hover:text-white" href="#">
            Knowledge
          </a>
          <a className="hover:text-white" href="#">
            Docs
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Settings size={18} aria-hidden />
          </button>

          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-sm font-semibold text-bell-blue"
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


