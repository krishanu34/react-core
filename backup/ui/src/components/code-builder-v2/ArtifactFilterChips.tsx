"use client";

/**
 * Shared "All / Starred / Flagged" filter chips used by both the
 * approved-artifact picker modals (User Stories and Documents) and the
 * inline ChatContextSelector summary. The chips key off the
 * ``run_is_selected`` (star) and ``run_review_flag`` (flag) booleans
 * inherited from the artifact's source generation_run.
 */

import React from "react";
import { Star, Flag, Check } from "lucide-react";

export type ArtifactFilter = "all" | "approved" | "starred" | "flagged";

interface ArtifactWithRunFlags {
  run_is_selected?: boolean;
  run_review_flag?: boolean;
  approval_status?: string | null;
}

/** Count starred / flagged / approved artifacts and the total. */
export function getArtifactFilterCounts(artifacts: ArtifactWithRunFlags[]) {
  let starred = 0;
  let flagged = 0;
  let approved = 0;
  for (const a of artifacts) {
    if (a.run_is_selected) starred += 1;
    if (a.run_review_flag) flagged += 1;
    if (a.approval_status === "approved") approved += 1;
  }
  return { all: artifacts.length, starred, flagged, approved };
}

/** Apply the chosen filter to an artifact list. */
export function applyArtifactFilter<T extends ArtifactWithRunFlags>(
  artifacts: T[],
  filter: ArtifactFilter,
): T[] {
  if (filter === "starred") return artifacts.filter((a) => !!a.run_is_selected);
  if (filter === "flagged") return artifacts.filter((a) => !!a.run_review_flag);
  if (filter === "approved") return artifacts.filter((a) => a.approval_status === "approved");
  return artifacts;
}

interface ArtifactFilterChipsProps {
  value: ArtifactFilter;
  onChange: (next: ArtifactFilter) => void;
  counts: { all: number; starred: number; flagged: number; approved?: number };
  size?: "sm" | "md";
  className?: string;
  /**
   * Optional whitelist of chips to render. When omitted, all chips are shown
   * (legacy behaviour). Pass e.g. ``["starred"]`` to render only the Starred
   * chip — used by surfaces that only care about a single filter.
   */
  visibleFilters?: ArtifactFilter[];
}

export function ArtifactFilterChips({
  value,
  onChange,
  counts,
  size = "md",
  className,
  visibleFilters,
}: ArtifactFilterChipsProps) {
  const items: Array<{
    key: ArtifactFilter;
    label: string;
    icon?: React.ElementType;
    count: number;
  }> = [
    { key: "all", label: "All", count: counts.all },
    { key: "approved", label: "Approved", icon: Check, count: counts.approved ?? 0 },
    { key: "starred", label: "Starred", icon: Star, count: counts.starred },
    { key: "flagged", label: "Flagged", icon: Flag, count: counts.flagged },
  ];
  const visibleItems = visibleFilters && visibleFilters.length > 0
    ? items.filter((item) => visibleFilters.includes(item.key))
    : items;

  const sizeClasses =
    size === "sm"
      ? "px-2 py-0.5 text-[10px]"
      : "px-2.5 py-1 text-[11px]";
  const iconSize = size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3";

  return (
    <div className={["flex items-center gap-1", className ?? ""].join(" ")}>
      {visibleItems.map((item) => {
        const active = value === item.key;
        const Icon = item.icon;
        const iconColor =
          active && item.key === "starred"
            ? "fill-yellow-400 text-yellow-400"
            : active && item.key === "flagged"
              ? "fill-orange-400 text-orange-400"
              : active && item.key === "approved"
                ? "text-emerald-400"
                : "";
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={[
              "flex items-center gap-1 rounded-full border font-medium transition-colors",
              sizeClasses,
              active
                ? "bg-cbv2-accent/15 text-cbv2-accent border-cbv2-accent/40"
                : "bg-cbv2-input text-cbv2-text-dim border-cbv2-border hover:text-cbv2-text",
            ].join(" ")}
          >
            {Icon && <Icon className={[iconSize, iconColor].join(" ")} />}
            <span>{item.label}</span>
            <span className="font-mono">({item.count})</span>
          </button>
        );
      })}
    </div>
  );
}

/** Small inline ✓ / ⭐ / 🚩 row used inside list rows and detail headers. */
export function RunFlagBadges({
  starred,
  flagged,
  approved,
  size = "sm",
}: {
  starred?: boolean;
  flagged?: boolean;
  approved?: boolean;
  size?: "xs" | "sm";
}) {
  if (!starred && !flagged && !approved) return null;
  const iconSize = size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5";
  return (
    <span className="inline-flex items-center gap-1">
      {approved && (
        <span
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[9px] font-medium"
          title="Approved artifact"
        >
          <Check className={`${iconSize}`} />
          Approved
        </span>
      )}
      {starred && (
        <span
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-300 border border-yellow-500/30 text-[9px] font-medium"
          title="From a starred run"
        >
          <Star className={`${iconSize} fill-yellow-400 text-yellow-400`} />
          Starred
        </span>
      )}
      {flagged && (
        <span
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-orange-500/10 text-orange-300 border border-orange-500/30 text-[9px] font-medium"
          title="From a flagged run"
        >
          <Flag className={`${iconSize} fill-orange-400 text-orange-400`} />
          Flagged
        </span>
      )}
    </span>
  );
}
