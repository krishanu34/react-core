"use client";

import React, { PropsWithChildren, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query-client";

export default function QueryProvider({ children }: PropsWithChildren<{}>) {
  const [Devtools, setDevtools] = useState<React.ComponentType<any> | null>(null);
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        (window as any).__queryClient = queryClient;
        (window as any).__queryProviderMounted = true;
        // quick debugging hint for console
        // eslint-disable-next-line no-console
        console.log("QueryProvider mounted — queryClient exposed on window.__queryClient");
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("QueryProvider mount: failed to expose queryClient", e);
    }

    return () => {
      try {
        if (typeof window !== "undefined") {
          delete (window as any).__queryClient;
          delete (window as any).__queryProviderMounted;
        }
      } catch {}
    };
  }, []);

  useEffect(() => {
    // Dynamically import DevTools only in development to avoid bundling in production
    if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
      import("@tanstack/react-query-devtools").then((mod) => {
        setDevtools(() => mod.ReactQueryDevtools ?? mod.ReactQueryDevtools);
      }).catch(() => {
        /* ignore import failures in unusual environments */
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {Devtools ? <Devtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}
