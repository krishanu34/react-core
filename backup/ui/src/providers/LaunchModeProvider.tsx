"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getToken, getUser } from "@/lib/auth";
import { fetchDevAccelContext, DevAccelContext, IntegrationError } from "@/lib/integration-api";
import type { LaunchMode } from "@/lib/launch-mode";

interface LaunchModeContextValue {
  mode: LaunchMode;
  projectContext: DevAccelContext["project_context"] | null;
  models: DevAccelContext["models"];
  connectors: DevAccelContext["connectors"] | null;
  loading: boolean;
  error: string | null;
}

const LaunchModeContext = createContext<LaunchModeContextValue>({
  mode: "standalone",
  projectContext: null,
  models: [],
  connectors: null,
  loading: false,
  error: null,
});

export function useLaunchMode() {
  return useContext(LaunchModeContext);
}

export function LaunchModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<LaunchMode>("standalone");
  const [projectContext, setProjectContext] = useState<DevAccelContext["project_context"] | null>(null);
  const [models, setModels] = useState<DevAccelContext["models"]>([]);
  const [connectors, setConnectors] = useState<DevAccelContext["connectors"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const user = getUser();
    if (!user || user.launch_mode !== "integrated") {
      setMode("standalone");
      return;
    }

    setMode("integrated");
    setLoading(true);

    const token = getToken();
    if (!token) {
      setError("Session token not found");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadContext() {
      try {
        const ctx = await fetchDevAccelContext(token!);
        if (cancelled) return;
        setProjectContext(ctx.project_context);
        setModels(ctx.models);
        setConnectors(ctx.connectors);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof IntegrationError) {
          setError(err.message);
        } else {
          setError("Failed to load DevAccel context");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadContext();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(
    () => ({ mode, projectContext, models, connectors, loading, error }),
    [mode, projectContext, models, connectors, loading, error],
  );

  return (
    <LaunchModeContext.Provider value={value}>
      {children}
    </LaunchModeContext.Provider>
  );
}
