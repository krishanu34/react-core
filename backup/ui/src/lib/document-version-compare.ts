import type { VersionSummary } from "@/lib/document-api";

export type ComparePair = {
  baseVersion: number;
  targetVersion: number;
};

export function normalizeComparePair(firstVersion: number | null | undefined, secondVersion: number | null | undefined): ComparePair | null {
  if (
    firstVersion == null
    || secondVersion == null
    || Number.isNaN(firstVersion)
    || Number.isNaN(secondVersion)
    || firstVersion === secondVersion
  ) {
    return null;
  }

  return firstVersion < secondVersion
    ? { baseVersion: firstVersion, targetVersion: secondVersion }
    : { baseVersion: secondVersion, targetVersion: firstVersion };
}

export function getDefaultComparePair(versions: VersionSummary[], currentVersion: number): ComparePair | null {
  if (versions.length < 2) return null;

  const orderedVersions = [...versions].sort((a, b) => a.version_number - b.version_number);
  const latestVersion = orderedVersions[orderedVersions.length - 1]?.version_number ?? null;
  const targetVersion = orderedVersions.some((v) => v.version_number === currentVersion)
    ? currentVersion
    : latestVersion;

  if (targetVersion == null) return null;

  const priorVersions = orderedVersions.filter((v) => v.version_number < targetVersion);
  if (priorVersions.length === 0) return null;

  const approvedPriorVersions = priorVersions.filter((v) => v.status === "approved");
  const baseVersion = approvedPriorVersions.length > 0
    ? approvedPriorVersions[approvedPriorVersions.length - 1].version_number
    : priorVersions[0].version_number;

  return normalizeComparePair(baseVersion, targetVersion);
}

export function formatVersionOptionLabel(version: VersionSummary): string {
  const triggerLabel = version.trigger_type === "initial"
    ? "Initial"
    : `Regen (${version.sections_changed.length} sections)`;
  const statusLabel = version.status === "approved"
    ? " ✓ Approved"
    : version.status === "rejected"
      ? " ✗ Rejected"
      : version.status === "superseded"
        ? " ◇ Superseded"
        : "";

  return `v${version.version_number} — ${triggerLabel}${statusLabel}`;
}