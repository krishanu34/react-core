"use client";

import { useState } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CancelJobButtonProps {
  onCancel: () => Promise<void>;
  disabled?: boolean;
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
}

export function CancelJobButton({
  onCancel,
  disabled = false,
  label = "Cancel",
  size = "sm",
}: CancelJobButtonProps) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        variant="destructive"
        size={size}
        disabled={disabled || cancelling}
        onClick={handleClick}
      >
        <XCircle className="mr-1 h-4 w-4" />
        {cancelling ? "Cancelling…" : label}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
