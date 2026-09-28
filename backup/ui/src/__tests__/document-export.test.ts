import { describe, expect, it } from "vitest";

import {
  normalizeGeneratedDocumentMarkdown,
  normalizeMarkdownTables,
  splitMarkdownTableRow,
} from "@/lib/document-export";

describe("document export markdown normalization", () => {
  it("splits collapsed headings from paragraph text", () => {
    const normalized = normalizeGeneratedDocumentMarkdown("## Overview System components are deployed across tiers.");

    expect(normalized).toBe("## Overview\n\nSystem components are deployed across tiers.");
  });

  it("unwraps only full-line bold paragraphs", () => {
    const normalized = normalizeGeneratedDocumentMarkdown([
      "**This paragraph should be normal text.**",
      "The **service layer** validates input.",
    ].join("\n"));

    expect(normalized).toContain("This paragraph should be normal text.");
    expect(normalized).toContain("The **service layer** validates input.");
  });

  it("does not absorb a following paragraph into a table", () => {
    const normalized = normalizeMarkdownTables([
      "| Name | Description |",
      "| --- | --- |",
      "| API | Handles requests |",
      "This paragraph belongs below the table.",
    ].join("\n"));

    expect(normalized).toBe([
      "| Name | Description |",
      "| --- | --- |",
      "| API | Handles requests |",
      "This paragraph belongs below the table.",
    ].join("\n"));
  });

  it("splits escaped pipes and inline-code pipes safely", () => {
    expect(splitMarkdownTableRow("| Field | Value\\|A | `x|y` |"))
      .toEqual(["Field", "Value|A", "`x|y`"]);
  });
});
