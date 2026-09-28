/**
 * Converts any value (string, array, object, nested) into human-readable text.
 * Used instead of JSON.stringify() to display story/document content in the UI.
 */

/**
 * Convert any value to a human-readable string (no raw JSON).
 */
export function formatValue(value: unknown, indent: number = 0): string {
  if (value == null) return "";
  const prefix = "  ".repeat(indent);

  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    // Check if it's a simple string array
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return value.map((v) => `${prefix}• ${String(v).trim()}`).join("\n");
    }
    // Mixed/object array — render each item
    return value
      .map((item, i) => {
        if (typeof item === "string" || typeof item === "number") {
          return `${prefix}• ${String(item).trim()}`;
        }
        if (typeof item === "object" && item !== null) {
          return `${prefix}${i + 1}. ${formatValue(item, indent + 1)}`;
        }
        return `${prefix}• ${String(item)}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj).filter(([, v]) => v != null && v !== "");
    if (entries.length === 0) return "";

    return entries
      .map(([key, val]) => {
        const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          return `${prefix}${label}: ${String(val).trim()}`;
        }
        if (Array.isArray(val)) {
          const items = formatValue(val, indent + 1);
          return items ? `${prefix}${label}:\n${items}` : "";
        }
        if (typeof val === "object" && val !== null) {
          const nested = formatValue(val, indent + 1);
          return nested ? `${prefix}${label}:\n${nested}` : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(value);
}

/**
 * Extract structured sections from content object.
 * Returns an array of { label, value } pairs with human-readable text (no JSON).
 */
export function extractContentSections(
  content: Record<string, unknown>,
  keyMap: Record<string, string>,
  skipKeys?: Set<string>,
): Array<{ label: string; value: string }> {
  const sections: Array<{ label: string; value: string }> = [];

  for (const [key, label] of Object.entries(keyMap)) {
    const val = content[key];
    if (!val || skipKeys?.has(key)) continue;

    const formatted = formatValue(val);
    if (formatted) {
      sections.push({ label, value: formatted });
    }
  }

  return sections;
}

/**
 * Fallback: render all remaining keys from content that weren't in keyMap.
 * Returns human-readable text for the entire object (no JSON.stringify).
 */
export function formatFallbackContent(content: Record<string, unknown>): string {
  return formatValue(content);
}
