import { QueryClient, MutationCache } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // Global safety-net: log unhandled mutation errors so they are never silent.
      // Individual mutations can still provide their own onError for UI-specific handling.
      if (mutation.options.onError) return; // already handled at hook/call-site level
      const msg = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`[MutationError] ${msg}`, error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 minute
      // Best-effort retry policy:
      // - Do not retry on client errors (4xx)
      // - Retry transient/server/network failures up to 3 attempts
      // - Exponential backoff with small jitter
      retry: (failureCount, error) => {
        try {
          const status = (error as any)?.status || (error as any)?.response?.status;
          if (typeof status === "number" && status >= 400 && status < 500) return false;
        } catch {}
        return failureCount < 3;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex + Math.random() * 300, 30_000),
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

export default queryClient;
