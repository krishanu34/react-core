import { describe, expect, it } from "vitest";

import {
  formatVersionOptionLabel,
  getDefaultComparePair,
  normalizeComparePair,
} from "@/lib/document-version-compare";
import type { VersionSummary } from "@/lib/document-api";

function makeVersionSummary(overrides: Partial<VersionSummary>): VersionSummary {
  return {
    id: overrides.id ?? 1,
    version_number: overrides.version_number ?? 1,
    trigger_type: overrides.trigger_type ?? "initial",
    status: overrides.status ?? "pending",
    sections_changed: overrides.sections_changed ?? [],
    comments_addressed: overrides.comments_addressed ?? [],
    created_at: overrides.created_at ?? null,
    approved_at: overrides.approved_at ?? null,
    approved_by: overrides.approved_by ?? null,
    rejection_reason: overrides.rejection_reason ?? null,
  };
}

describe("normalizeComparePair", () => {
  it("returns versions in ascending order", () => {
    expect(normalizeComparePair(5, 2)).toEqual({ baseVersion: 2, targetVersion: 5 });
  });

  it("returns null for identical versions", () => {
    expect(normalizeComparePair(3, 3)).toBeNull();
  });

  it("returns null for missing values", () => {
    expect(normalizeComparePair(null, 3)).toBeNull();
    expect(normalizeComparePair(2, undefined)).toBeNull();
  });
});

describe("getDefaultComparePair", () => {
  it("prefers the latest earlier approved version as the base", () => {
    const versions = [
      makeVersionSummary({ version_number: 1, status: "superseded" }),
      makeVersionSummary({ id: 2, version_number: 2, status: "approved", trigger_type: "regenerate" }),
      makeVersionSummary({ id: 3, version_number: 3, status: "pending", trigger_type: "regenerate" }),
    ];

    expect(getDefaultComparePair(versions, 3)).toEqual({ baseVersion: 2, targetVersion: 3 });
  });

  it("falls back to the earliest prior version when no approved version exists", () => {
    const versions = [
      makeVersionSummary({ version_number: 1, status: "superseded" }),
      makeVersionSummary({ id: 2, version_number: 2, status: "pending", trigger_type: "regenerate" }),
    ];

    expect(getDefaultComparePair(versions, 2)).toEqual({ baseVersion: 1, targetVersion: 2 });
  });

  it("falls back to the latest version when currentVersion is not in the list", () => {
    const versions = [
      makeVersionSummary({ version_number: 1, status: "approved" }),
      makeVersionSummary({ id: 2, version_number: 2, status: "superseded", trigger_type: "regenerate" }),
      makeVersionSummary({ id: 3, version_number: 3, status: "pending", trigger_type: "regenerate" }),
    ];

    expect(getDefaultComparePair(versions, 99)).toEqual({ baseVersion: 1, targetVersion: 3 });
  });

  it("returns null when fewer than two versions are available", () => {
    expect(getDefaultComparePair([makeVersionSummary({ version_number: 1 })], 1)).toBeNull();
  });
});

describe("formatVersionOptionLabel", () => {
  it("formats trigger and status details for selectors", () => {
    const label = formatVersionOptionLabel(
      makeVersionSummary({
        version_number: 4,
        trigger_type: "regenerate",
        sections_changed: ["intro", "security"],
        status: "approved",
      }),
    );

    expect(label).toBe("v4 — Regen (2 sections) ✓ Approved");
  });
});