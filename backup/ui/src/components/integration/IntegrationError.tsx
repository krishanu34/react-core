"use client";

import { useRouter } from "next/navigation";

interface IntegrationErrorProps {
  message?: string;
}

/**
 * Error display component for failed DevAccel handshakes.
 * Shows a clear message with two action options.
 */
export function IntegrationError({ message }: IntegrationErrorProps) {
  const router = useRouter();

  return (
    <div className="flex min-h-[400px] items-center justify-center p-6">
      <div className="max-w-md w-full space-y-6 text-center">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-destructive">
            Unable to load project context from DevAccel
          </h2>
          {message && (
            <p className="text-sm text-muted-foreground">{message}</p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Please return to DevAccel to relaunch, or log in to Workspace Studio directly.
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
