"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { exchangeHandoffToken, IntegrationError } from "@/lib/integration-api";
import { setToken } from "@/lib/auth";

/**
 * /integrate — SSO handoff landing page.
 *
 * DevAccel redirects here with ?token=<handoff_token>&project_id=<id>&mode=integrated.
 * This page exchanges the token for a WS session, then redirects to workspaces.
 * On failure, shows an error with options to retry or login directly.
 */
function IntegrateHandoff() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError("No handoff token provided. Please launch from DevAccel or log in directly.");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function doHandoff() {
      try {
        const result = await exchangeHandoffToken(token!);
        if (cancelled) return;

        // Store the WS session token
        setToken(result.access_token);

        // Full-page navigation ensures the freshly-set auth_token cookie is
        // included in the request. router.replace() can use a stale RSC cache
        // entry that was fetched before the cookie existed, causing the proxy
        // to redirect to /login on the first handoff attempt.
        window.location.replace("/workspaces");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof IntegrationError) {
          setError(err.message);
        } else {
          setError("An unexpected error occurred during integration. Please try again.");
        }
        setLoading(false);
      }
    }

    doHandoff();
    return () => { cancelled = true; };
  }, [searchParams, router]);

  if (loading) return <Connecting />;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md w-full p-6 space-y-6 text-center">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-destructive">Integration Failed</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Unable to load project context from DevAccel. Please return to DevAccel to relaunch, or log in to Workspace Studio directly.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => window.history.back()}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
            >
              Return to DevAccel
            </button>
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent"
            >
              Login to Workspace Studio
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function Connecting() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
        <p className="text-muted-foreground">Connecting to DevAccel...</p>
      </div>
    </div>
  );
}

// useSearchParams() opts the subtree out of prerendering, so it must sit inside a
// Suspense boundary or `next build` fails on the static export of this route.
export default function IntegratePage() {
  return (
    <Suspense fallback={<Connecting />}>
      <IntegrateHandoff />
    </Suspense>
  );
}
