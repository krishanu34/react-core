/**
 * document-export.ts
 * ==================
 * Client-side export utilities for design documents.
 * Converts markdown content + sections into Markdown, DOCX, PDF, and HTML.
 */

import { saveAs } from "file-saver";
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Packer,
} from "docx";
import type { DocumentSection } from "./document-api";
import { sanitizeMermaidCode } from "./mermaid-utils";

// ── Helpers ───────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_");
}

export function normalizeMermaidBlocks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    const stripped = lines[i].trim();
    if (stripped.toUpperCase() === "[MERMAID]") {
      i += 1;
      const block: string[] = [];
      for (; i < lines.length; i++) {
        const candidate = lines[i];
        const candidateStripped = candidate.trim();
        if (candidateStripped.startsWith("```")) break;
        if (block.length > 0 && (candidateStripped.startsWith("#") || candidateStripped === "---" || candidateStripped.toUpperCase() === "[MERMAID]")) {
          break;
        }
        if (block.length > 0 && candidateStripped === "") {
          let lookahead = i + 1;
          while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
          if (lookahead >= lines.length || lines[lookahead].trim().startsWith("#") || lines[lookahead].trim() === "---") {
            i = lookahead;
            break;
          }
        }
        block.push(candidate);
      }

      const mermaid = sanitizeMermaidCode(block.join("\n"));
      if (mermaid) {
        out.push("```mermaid", mermaid, "```");
      }
      continue;
    }

    out.push(lines[i]);
    i += 1;
  }

  return out.join("\n");
}

/** Very lightweight markdown → plain-text paragraph splitter. */
function markdownToTextRuns(md: string): Paragraph[] {
  const lines = md.split("\n");
  const paragraphs: Paragraph[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Headings
    const h1 = /^#\s+(.+)/.exec(trimmed);
    if (h1) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: h1[1], bold: true })] }));
      continue;
    }
    const h2 = /^##\s+(.+)/.exec(trimmed);
    if (h2) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: h2[1], bold: true })] }));
      continue;
    }
    const h3 = /^###\s+(.+)/.exec(trimmed);
    if (h3) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: h3[1], bold: true })] }));
      continue;
    }
    const h4 = /^####\s+(.+)/.exec(trimmed);
    if (h4) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_4, children: [new TextRun({ text: h4[1], bold: true })] }));
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: "―".repeat(50), color: "999999" })] }));
      continue;
    }

    // Bullet point
    const bullet = /^[-*+]\s+(.+)/.exec(trimmed);
    if (bullet) {
      paragraphs.push(new Paragraph({
        bullet: { level: 0 },
        children: parseInlineFormatting(bullet[1]),
      }));
      continue;
    }

    // Numbered list
    const numbered = /^\d+\.\s+(.+)/.exec(trimmed);
    if (numbered) {
      paragraphs.push(new Paragraph({
        bullet: { level: 0 },
        children: parseInlineFormatting(numbered[1]),
      }));
      continue;
    }

    // Empty line → spacing
    if (!trimmed) {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }

    // Normal paragraph
    paragraphs.push(new Paragraph({
      children: parseInlineFormatting(trimmed),
      spacing: { after: 120 },
    }));
  }

  return paragraphs;
}

/** Parse inline markdown formatting: **bold**, *italic*, `code` */
function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Simple regex-based split for bold, italic, and code
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    if (match[2]) {
      // Bold
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      // Italic
      runs.push(new TextRun({ text: match[3], italics: true }));
    } else if (match[4]) {
      // Code
      runs.push(new TextRun({ text: match[4], font: "Consolas", shading: { fill: "f0f0f0" } }));
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text }));
  }

  return runs;
}

// ── Table normalization helper ────────────────────────────────────────────

const MARKDOWN_BLOCK_START_RE = /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|```|~~~|>|!\[|<\/?(?:table|thead|tbody|tr|td|th|p|h\d|ul|ol|li|pre|blockquote)\b)/i;
const HORIZONTAL_RULE_RE = /^\s*[-*_]{3,}\s*$/;

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return MARKDOWN_BLOCK_START_RE.test(trimmed) || HORIZONTAL_RULE_RE.test(trimmed);
}

function countUnescapedPipes(line: string): number {
  let count = 0;
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "`" && line[i - 1] !== "\\") {
      inCode = !inCode;
    } else if (char === "|" && line[i - 1] !== "\\" && !inCode) {
      count += 1;
    }
  }
  return count;
}

export function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || !trimmed.includes("|")) return false;
  if (MARKDOWN_BLOCK_START_RE.test(trimmed) && !trimmed.startsWith("|")) return false;
  return countUnescapedPipes(trimmed) >= 2 || (trimmed.startsWith("|") && countUnescapedPipes(trimmed) >= 1);
}

export function isMarkdownTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitMarkdownTableRow(trimmed);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && trimmed[trimmed.length - 2] !== "\\") trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const prev = trimmed[i - 1];
    if (char === "`" && prev !== "\\") {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === "|" && prev !== "\\" && !inCode) {
      cells.push(current.trim().replace(/\\\|/g, "|"));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim().replace(/\\\|/g, "|"));
  return cells;
}

function normalizeBodyEmphasis(line: string): string {
  if (/^\s*#{1,6}\s+/.test(line)) return line;
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  const trimmed = line.trim();
  const fullLineBold = /^\*\*([^*](?:.|\n)*?[^*])\*\*$/.exec(trimmed);
  if (!fullLineBold) return line;
  return `${leading}${fullLineBold[1].trim()}${trailing}`;
}

function splitMalformedHeadingLine(line: string): string[] {
  const trimmed = line.trim();
  const match = /^(#{1,6}\s+)(.+)$/.exec(trimmed);
  if (!match) return [line];

  const [, prefix, body] = match;
  const patterns = [
    /\s+(-\s+|\d+\.\s+|\*\s+)/g,
    /\s+((?:The|This|These|Those|A|An|All|Each|In|For|To|By|Below|System|Systems|Users|User|Key|It|When|Because|Components|Application|Applications|Data|API|Service|Services|Architecture|Design|Implementation|Integration|Security|Performance)\b)/g,
  ];
  let splitAt: number | null = null;

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let candidate: RegExpExecArray | null;
    while ((candidate = pattern.exec(body)) !== null) {
      if (candidate.index >= 8) {
        splitAt = splitAt == null ? candidate.index : Math.min(splitAt, candidate.index);
        break;
      }
    }
  }

  const firstSentenceEnd = body.search(/[.!?]\s+\S/);
  if (firstSentenceEnd >= 24) {
    splitAt = splitAt == null ? firstSentenceEnd + 1 : Math.min(splitAt, firstSentenceEnd + 1);
  }

  if (splitAt == null) return [line];
  const headingText = body.slice(0, splitAt).trim().replace(/:$/, "");
  const remainder = body.slice(splitAt).trim();
  if (!headingText || !remainder) return [line];
  return [`${prefix}${headingText}`, "", remainder];
}

export function normalizeGeneratedMarkdownStructure(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const normalized: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      normalized.push(line);
      continue;
    }

    if (inCodeFence || !trimmed) {
      normalized.push(line);
      continue;
    }

    const rewritten = line
      .replace(/(\S)\s+(#{1,6}\s+)/g, "$1\n\n$2")
      .replace(/([.!?:])\s+(-\s+)/g, "$1\n$2");

    rewritten.split("\n").forEach((chunk) => {
      splitMalformedHeadingLine(chunk).forEach((part) => normalized.push(normalizeBodyEmphasis(part)));
    });
  }

  const setextSafe: string[] = [];
  for (const line of normalized) {
    const previous = setextSafe[setextSafe.length - 1]?.trim() ?? "";
    if (HORIZONTAL_RULE_RE.test(line) && previous && !isMarkdownBlockStart(previous) && !isMarkdownTableRow(previous)) {
      setextSafe.push("");
    }
    setextSafe.push(line);
  }

  return setextSafe.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Fix multi-line markdown table rows produced by LLMs.
 * Joins continuation lines (that don't start with |) back onto the previous
 * table row so every logical row is a single line.
 */
export function normalizeMarkdownTables(md: string): string {
  const lines = normalizeMermaidBlocks(md).split("\n");
  const out: string[] = [];
  let inTable = false;

  for (let j = 0; j < lines.length; j += 1) {
    const line = lines[j];
    const trimmed = line.trim();
    const currentIsTableRow = isMarkdownTableRow(trimmed) || isMarkdownTableSeparatorRow(trimmed);

    if (!trimmed) {
      inTable = false;
      out.push(line);
      continue;
    }

    if (currentIsTableRow) {
      inTable = true;
      const cells = splitMarkdownTableRow(line);
      out.push(`| ${cells.join(" | ")} |`);
      continue;
    }

    if (inTable && out.length > 0 && !isMarkdownBlockStart(trimmed)) {
      const nextLine = lines[j + 1]?.trim() ?? "";
      const likelyWrappedCell = isMarkdownTableRow(nextLine) || isMarkdownTableSeparatorRow(nextLine);
      if (likelyWrappedCell) {
        const prev = out[out.length - 1];
        out[out.length - 1] = prev.endsWith("|")
          ? `${prev.slice(0, -1).trimEnd()} ${trimmed} |`
          : `${prev} ${trimmed}`;
        continue;
      }
    }

    inTable = false;
    out.push(line);
  }
  return out.join("\n");
}

export function normalizeGeneratedDocumentMarkdown(markdown: string): string {
  return normalizeMarkdownTables(normalizeGeneratedMarkdownStructure(normalizeMermaidBlocks(markdown)));
}

// ── Export: Markdown ──────────────────────────────────────────────────────

export function downloadAsMarkdown(markdown: string, title: string): void {
  const normalized = normalizeGeneratedDocumentMarkdown(markdown);
  const blob = new Blob([normalized], { type: "text/markdown;charset=utf-8" });
  saveAs(blob, `${sanitizeFilename(title)}.md`);
}

// ── Export: HTML ──────────────────────────────────────────────────────────

function markdownToHtml(md: string, title: string): string {
  // ── Pre-process: normalize multi-line table rows & convert to HTML ──
  // Step 1: normalize multi-line rows using shared helper
  const normalized = normalizeGeneratedDocumentMarkdown(md);

  // Step 2: convert table blocks to HTML
  const joined = normalized.split("\n");
  const processed: string[] = [];
  let i = 0;
  while (i < joined.length) {
    const trimmed = joined[i].trim();
    if (isMarkdownTableRow(trimmed)) {
      const tableLines: string[] = [];
      while (i < joined.length) {
        const tl = joined[i].trim();
        if (isMarkdownTableRow(tl) || isMarkdownTableSeparatorRow(tl)) {
          tableLines.push(tl);
          i++;
        } else {
          break;
        }
      }
      const rows = tableLines.filter(l => !isMarkdownTableSeparatorRow(l));
      if (rows.length > 0) {
        let tableHtml = "<table>";
        rows.forEach((row, ri) => {
          const cells = splitMarkdownTableRow(row);
          const tag = ri === 0 ? "th" : "td";
          tableHtml += "<tr>" + cells.map(c => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
        });
        tableHtml += "</table>";
        processed.push(tableHtml);
      }
      continue;
    }
    processed.push(joined[i]);
    i++;
  }

  // Simple markdown to HTML conversion
  const html = processed.join("\n")
    // Mermaid blocks
    .replace(/```mermaid\n([\s\S]*?)```/g, (_match, code) => `<pre class="mermaid">${sanitizeMermaidCode(String(code))}</pre>`)
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    // Headings
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Images (before bold/italic so ![...] doesn't get mangled)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:6px;margin:12px 0;" />')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`(.+?)`/g, '<code style="background:#f0f0f0;padding:2px 4px;border-radius:3px;font-size:0.9em;">$1</code>')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "<hr/>")
    // Unordered lists
    .replace(/^[-*+] (.+)$/gm, "<li>$1</li>")
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    // Wrap consecutive <li> in <ul>
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    // Paragraphs (lines not already wrapped — also skip <table and <img)
    .replace(/^(?!<[hupol]|<li|<hr|<pre|<table|<img)(.+)$/gm, "<p>$1</p>")
    // Line breaks
    .replace(/\n\n/g, "\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; line-height: 1.7; }
    h1 { color: #111; border-bottom: 2px solid #e5e5e5; padding-bottom: 8px; margin-top: 32px; }
    h2 { color: #222; border-bottom: 1px solid #eee; padding-bottom: 6px; margin-top: 28px; }
    h3 { color: #333; margin-top: 24px; }
    h4 { color: #444; margin-top: 20px; }
    pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.9em; }
    code { font-family: 'SFMono-Regular', Consolas, monospace; }
    ul, ol { padding-left: 24px; }
    li { margin-bottom: 4px; }
    hr { border: none; border-top: 1px solid #e5e5e5; margin: 24px 0; }
    p { margin: 8px 0; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    tr:nth-child(even) td { background: #f9fafb; }
    img { max-width: 100%; border-radius: 6px; margin: 12px 0; }
    .mermaid { background: #fff; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; margin: 16px 0; overflow-x: auto; }
    @media print { body { max-width: none; padding: 20px; } }
  </style>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
    window.__mermaidRenderPromise = mermaid.run({ querySelector: ".mermaid" }).catch(() => undefined);
  </script>
</head>
<body>
${html}
</body>
</html>`;
}

export function downloadAsHtml(markdown: string, title: string): void {
  const html = markdownToHtml(markdown, title);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  saveAs(blob, `${sanitizeFilename(title)}.html`);
}

// ── Export: DOCX ─────────────────────────────────────────────────────────

export async function downloadAsDocx(
  markdown: string,
  title: string,
  sections: DocumentSection[],
): Promise<void> {
  const docChildren: Paragraph[] = [];

  // Title page
  docChildren.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 2400, after: 400 },
    children: [new TextRun({ text: title, bold: true, size: 56 })],
  }));
  docChildren.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: `Generated on ${new Date().toLocaleDateString()}`, color: "666666", size: 24 })],
  }));
  docChildren.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 1200 },
    children: [new TextRun({ text: `${sections.length} sections`, color: "999999", size: 22 })],
  }));

  // Table of contents
  docChildren.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: "Table of Contents", bold: true })],
  }));
  for (const section of sections.sort((a, b) => a.order - b.order)) {
    docChildren.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text: `${section.order}. ${section.title}`, color: "0066cc" })],
    }));
  }
  docChildren.push(new Paragraph({ children: [] }));

  // Sections
  for (const section of sections.sort((a, b) => a.order - b.order)) {
    docChildren.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 480 },
      children: [new TextRun({ text: `${section.order}. ${section.title}`, bold: true })],
    }));

    // Convert section content from markdown to paragraphs
    const sectionParagraphs = markdownToTextRuns(section.content);
    docChildren.push(...sectionParagraphs);

    // Traceability
    if (section.traceability_links.length > 0) {
      docChildren.push(new Paragraph({ children: [] }));
      docChildren.push(new Paragraph({
        children: [
          new TextRun({ text: "Traceability: ", bold: true, italics: true, size: 18, color: "666666" }),
          new TextRun({ text: section.traceability_links.join(", "), italics: true, size: 18, color: "666666" }),
        ],
      }));
    }
  }

  const doc = new Document({
    title,
    creator: "DevAccel Document Builder",
    description: `${title} - Auto-generated HLD`,
    sections: [{
      properties: {},
      children: docChildren,
    }],
  });

  const buffer = await Packer.toBlob(doc);
  saveAs(buffer, `${sanitizeFilename(title)}.docx`);
}

// ── Export: PDF (browser print) ──────────────────────────────────────────

export function downloadAsPdf(markdown: string, title: string): void {
  const html = markdownToHtml(markdown, title);

  // Open a new window and trigger print (Save as PDF)
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    alert("Please allow popups to download PDF.");
    return;
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Wait for content to render, then trigger print dialog
  printWindow.onload = () => {
    setTimeout(async () => {
      try {
        await (printWindow as Window & { __mermaidRenderPromise?: Promise<unknown> }).__mermaidRenderPromise;
      } catch {
        // Ignore render failures and still allow print.
      }
      printWindow.print();
    }, 500);
  };
  // Fallback if onload doesn't fire
  setTimeout(() => {
    printWindow.print();
  }, 1500);
}

// ── Export format types ──────────────────────────────────────────────────

export type ExportFormat = "markdown" | "docx" | "pdf" | "html";

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string; desc: string }[] = [
  { value: "markdown", label: "Markdown",     ext: ".md",   desc: "Raw markdown source" },
  { value: "docx",     label: "Word (DOCX)",  ext: ".docx", desc: "Branded Word document with headers & footers" },
  { value: "pdf",      label: "PDF",          ext: ".pdf",  desc: "Branded PDF with cover page & headers" },
  { value: "html",     label: "HTML",         ext: ".html", desc: "Standalone HTML page" },
];
