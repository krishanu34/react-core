"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface BufferedProgressBarProps {
  progress: number;
  stage?: string | null;
  detail?: string | null;
  filesDone?: number;
  filesTotal?: number;
  className?: string;
}

export function BufferedProgressBar({
  progress,
  stage,
  detail,
  filesDone,
  filesTotal,
  className,
}: BufferedProgressBarProps) {
  const pct = useMemo(() => Math.min(Math.max(progress, 0), 100), [progress]);
  const hasFiles =
    typeof filesDone === "number" &&
    typeof filesTotal === "number" &&
    filesTotal > 0;

  return (
    <div className={cn("w-full space-y-1", className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium capitalize">{stage ?? "Initializing"}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground/70">
        <span className="max-w-[70%] truncate">{detail ?? ""}</span>
        {hasFiles && <span>{filesDone}/{filesTotal} files</span>}
      </div>
    </div>
  );
}
