/**
 * documentExtract — client-side counterpart of the backend's `ingestion/`.
 *
 * WHY THIS EXISTS AT ALL, given the server already has a full extractor:
 * `read_file` is a CLIENT tool (see CLIENT_TOOLS in clientTools.ts). The files
 * it reads live on the user's machine, and the server cannot see them. So for
 * a document sitting in the user's own repo — a spec.docx, an architecture
 * .pdf — the server's extractor is not reachable, and sending the bytes up to
 * reach it would upload a file the user never chose to share.
 *
 * Before this module, clientTools.readFile refused those files by extension:
 *
 *     if (BINARY_EXT.has(e)) return { binary: true, message: "Cannot display content." }
 *
 * — returned WITHOUT even attempting a read, so "summarise the spec in my
 * repo" failed the same way whether or not the file existed.
 *
 * The two extractors are deliberately kept to the same CONTRACT (kind, text,
 * images, notes, honest limits) rather than the same code, because they run in
 * incomparable environments. Where they differ, the difference is stated in a
 * note the model reads, so the model is never silently working from less than
 * it thinks. Attachments still go through the PYTHON extractor — they are
 * uploaded once for exactly that reason — so this is the local-file path only.
 *
 * Everything heavy is dynamically imported: a session that never reads a PDF
 * never loads pdfjs.
 */

/* ── The shape every extractor returns (mirrors ingestion/content.py) ─────── */

export type DocumentKind =
  | "text" | "tabular" | "html" | "notebook"
  | "pdf" | "document" | "spreadsheet" | "presentation"
  | "image" | "archive" | "audio" | "video" | "binary";

export interface ExtractedImage {
  /** image/png | image/jpeg | image/gif | image/webp */
  mime_type: string;
  /** base64, no data: prefix — matches the server's vision payload shape. */
  data: string;
  filename: string;
}

export interface ExtractedDocument {
  kind: DocumentKind;
  /** Human/model-readable format name, e.g. "Word document (.docx)". */
  label: string;
  /** "" when nothing was extractable. */
  text: string;
  images: ExtractedImage[];
  /** pages / sheets / slides / rows / entries / duration … */
  metadata: Record<string, string | number>;
  /** Limitations, failures, and what to do instead. Always surfaced. */
  notes: string[];
  truncated: boolean;
  /** Which backend produced the text, for debugging a bad extraction. */
  extractor: string;
  sizeBytes: number;
}

function empty(kind: DocumentKind, label: string, sizeBytes = 0): ExtractedDocument {
  return {
    kind, label, text: "", images: [], metadata: {}, notes: [],
    truncated: false, extractor: "", sizeBytes,
  };
}

/* ── Limits ──────────────────────────────────────────────────────────────────
   Same reasoning as ingestion/limits.py: the model has a fixed context window,
   and an unbounded extraction does not fail loudly — it pushes the user's
   actual question out of the window and the answer quietly gets worse. These
   are smaller than the server's because a tool RESULT is capped harder than a
   first-message attachment digest. */
const MAX_TEXT_CHARS   = 120_000;
const MAX_PDF_PAGES    = 50;
const MAX_SHEETS       = 20;
const MAX_SHEET_ROWS   = 500;
const MAX_SLIDES       = 200;
const MAX_ARCHIVE_ENTRIES = 200;
const MAX_NOTEBOOK_CELLS  = 300;
/** Images larger than this are reported rather than sent — base64 inflates 4/3. */
const MAX_IMAGE_BYTES  = 5 * 1024 * 1024;

/** Media types a vision model accepts inline. Others are named, not sent. */
const VISION_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function clip(text: string, limit = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/* ── Detection ───────────────────────────────────────────────────────────────
   Magic bytes first, then the ZIP container's member list (the only thing that
   separates .docx from .xlsx from a plain archive), then the extension. Same
   precedence as detect.py, and for the same reason: a file's own bytes cannot
   be wrong about what it is, and its name can. */

export interface DetectedType {
  kind: DocumentKind;
  label: string;
  ext: string;
  mime: string;
}

const TEXTUAL_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log", ".json", ".jsonl", ".ndjson",
  ".yaml", ".yml", ".toml", ".xml", ".svg", ".ini", ".cfg", ".conf", ".env",
  ".properties", ".sql", ".graphql", ".proto", ".patch", ".diff",
]);

const EXT_LABELS: Record<string, [DocumentKind, string, string]> = {
  ".pdf":  ["pdf", "PDF document", "application/pdf"],
  ".docx": ["document", "Word document (.docx)", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".doc":  ["document", "Word 97-2003 document (.doc)", "application/msword"],
  ".rtf":  ["document", "RTF document", "application/rtf"],
  ".xlsx": ["spreadsheet", "Excel workbook (.xlsx)", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".xls":  ["spreadsheet", "Excel 97-2003 workbook (.xls)", "application/vnd.ms-excel"],
  ".pptx": ["presentation", "PowerPoint presentation (.pptx)", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".ppt":  ["presentation", "PowerPoint 97-2003 presentation (.ppt)", "application/vnd.ms-powerpoint"],
  ".csv":  ["tabular", "CSV data", "text/csv"],
  ".tsv":  ["tabular", "TSV data", "text/tab-separated-values"],
  ".html": ["html", "HTML", "text/html"],
  ".htm":  ["html", "HTML", "text/html"],
  ".ipynb":["notebook", "Jupyter notebook", "application/x-ipynb+json"],
  ".png":  ["image", "PNG image", "image/png"],
  ".jpg":  ["image", "JPEG image", "image/jpeg"],
  ".jpeg": ["image", "JPEG image", "image/jpeg"],
  ".gif":  ["image", "GIF image", "image/gif"],
  ".webp": ["image", "WebP image", "image/webp"],
  ".bmp":  ["image", "BMP image", "image/bmp"],
  ".ico":  ["image", "Icon", "image/x-icon"],
  ".zip":  ["archive", "ZIP archive", "application/zip"],
  ".jar":  ["archive", "Java archive", "application/java-archive"],
  ".tar":  ["archive", "tar archive", "application/x-tar"],
  ".gz":   ["archive", "gzip archive", "application/gzip"],
  ".7z":   ["archive", "7-Zip archive", "application/x-7z-compressed"],
  ".rar":  ["archive", "RAR archive", "application/vnd.rar"],
  ".mp4":  ["video", "MP4 video", "video/mp4"],
  ".mov":  ["video", "QuickTime video", "video/quicktime"],
  ".webm": ["video", "WebM video", "video/webm"],
  ".avi":  ["video", "AVI video", "video/x-msvideo"],
  ".mkv":  ["video", "Matroska video", "video/x-matroska"],
  ".mp3":  ["audio", "MP3 audio", "audio/mpeg"],
  ".wav":  ["audio", "WAV audio", "audio/wav"],
  ".m4a":  ["audio", "M4A audio", "audio/mp4"],
  ".flac": ["audio", "FLAC audio", "audio/flac"],
  ".ogg":  ["audio", "Ogg audio", "audio/ogg"],
};

export function extname(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** ZIP members that identify an OOXML format. */
const ZIP_MEMBERS: Array<[string, DocumentKind, string, string]> = [
  ["word/document.xml", "document", "Word document (.docx)", ".docx"],
  ["xl/workbook.xml", "spreadsheet", "Excel workbook (.xlsx)", ".xlsx"],
  ["ppt/presentation.xml", "presentation", "PowerPoint presentation (.pptx)", ".pptx"],
];

export async function detectType(bytes: Uint8Array, path: string): Promise<DetectedType> {
  const ext = extname(path);

  // 1. Unambiguous magic bytes.
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46]))                     // %PDF
    return { kind: "pdf", label: "PDF document", ext, mime: "application/pdf" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]))
    return { kind: "image", label: "PNG image", ext, mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { kind: "image", label: "JPEG image", ext, mime: "image/jpeg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]))
    return { kind: "image", label: "GIF image", ext, mime: "image/gif" };
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]))               // {\rtf
    return { kind: "document", label: "RTF document", ext, mime: "application/rtf" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length > 12
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
    return { kind: "image", label: "WebP image", ext, mime: "image/webp" };

  // 2. ZIP container — the members say which OOXML format (if any) it is.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(bytes);
      for (const [member, kind, label, canonical] of ZIP_MEMBERS) {
        if (zip.file(member)) {
          return { kind, label, ext: canonical, mime: EXT_LABELS[canonical][2] };
        }
      }
    } catch {
      /* Corrupt or truncated zip — fall through and report it as an archive,
         which is the honest answer: we could not see inside it. */
    }
    return { kind: "archive", label: "ZIP archive", ext: ext || ".zip", mime: "application/zip" };
  }

  // 3. Extension.
  const mapped = EXT_LABELS[ext];
  if (mapped) return { kind: mapped[0], label: mapped[1], ext, mime: mapped[2] };
  if (TEXTUAL_EXT.has(ext)) return { kind: "text", label: "Text file", ext, mime: "text/plain" };

  // 4. Content heuristic — a NUL in the first 8 KB means binary, as in git.
  const head = bytes.subarray(0, 8192);
  const hasNul = head.some((b) => b === 0);
  if (!hasNul) return { kind: "text", label: `Text file${ext ? ` (${ext})` : ""}`, ext, mime: "text/plain" };
  return { kind: "binary", label: `Binary file${ext ? ` (${ext})` : ""}`, ext, mime: "application/octet-stream" };
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

/**
 * Turn a local file's bytes into something the model can reason about.
 * Never throws: a malformed file costs a note, not the agent's turn.
 */
export async function extractDocument(
  bytes: Uint8Array,
  path: string,
): Promise<ExtractedDocument> {
  let type: DetectedType;
  try {
    type = await detectType(bytes, path);
  } catch {
    type = { kind: "binary", label: "Unrecognised file", ext: extname(path), mime: "application/octet-stream" };
  }

  const out = empty(type.kind, type.label, bytes.length);
  try {
    switch (type.kind) {
      case "pdf":          await extractPdf(bytes, out); break;
      case "document":     await extractDocx(bytes, out, type); break;
      case "spreadsheet":  await extractXlsx(bytes, out, type); break;
      case "presentation": await extractPptx(bytes, out, type); break;
      case "archive":      await extractArchive(bytes, out); break;
      case "image":        await extractImage(bytes, out, type, path); break;
      case "notebook":     extractNotebook(bytes, out); break;
      case "html":         extractHtml(bytes, out); break;
      case "tabular":      extractTabular(bytes, out, type); break;
      case "text":         extractText(bytes, out); break;
      case "audio":
      case "video":        extractMedia(out, type); break;
      default:
        out.notes.push(
          `${type.label} — binary content with no text representation. Nothing ` +
          `was extracted. The file is on your machine and its path can still be ` +
          `passed to other tools.`,
        );
    }
  } catch (e) {
    out.notes.push(
      `This file could not be parsed (${e instanceof Error ? e.name : "error"}). ` +
      `It may be corrupt, incomplete, or not really a ${type.label}.`,
    );
  }

  const clipped = clip(out.text);
  out.text = clipped.text;
  if (clipped.truncated) {
    out.truncated = true;
    out.notes.push(
      `Text truncated at ${MAX_TEXT_CHARS.toLocaleString()} characters. Ask for a ` +
      `specific section by name or heading to see more.`,
    );
  }
  return out;
}

/* ── Text-shaped formats ─────────────────────────────────────────────────── */

/**
 * Decode bytes to text. UTF-8 first (strict, so a clean decode is near-proof),
 * then windows-1252. UTF-16 is only tried on a byte-order mark: it "succeeds"
 * on ANY even-length byte string, so trying it speculatively corrupts every
 * Windows-authored file — the same trap the Python side hit.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length === 0) return { text: "", encoding: "utf-8" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

function extractText(bytes: Uint8Array, out: ExtractedDocument): void {
  const { text, encoding } = decodeText(bytes);
  out.text = text;
  out.extractor = "decode";
  out.metadata.encoding = encoding;
  if (encoding !== "utf-8") out.notes.push(`Decoded as ${encoding} (not UTF-8).`);
}

function extractTabular(bytes: Uint8Array, out: ExtractedDocument, type: DetectedType): void {
  const { text } = decodeText(bytes);
  const delimiter = type.ext === ".tsv" ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  out.extractor = "delimited";
  if (lines.length === 0) { out.notes.push("File is empty."); return; }

  out.metadata.rows = lines.length;
  out.metadata.columns = lines[0].split(delimiter).length;
  const shown = lines.slice(0, MAX_SHEET_ROWS);
  out.text = `Columns (${out.metadata.columns}): ${lines[0]}\n\n${shown.join("\n")}`;
  if (lines.length > shown.length) {
    out.truncated = true;
    out.notes.push(`Showing the first ${shown.length} of ${lines.length} rows.`);
  }
}

function extractHtml(bytes: Uint8Array, out: ExtractedDocument): void {
  const { text } = decodeText(bytes);
  const doc = new DOMParser().parseFromString(text, "text/html");
  // Script and style bodies are never what someone wants read, and a bundled
  // JS payload inside an .html export can exceed the whole context window.
  doc.querySelectorAll("script, style, noscript, svg").forEach((n) => n.remove());
  out.text = (doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  out.extractor = "DOMParser";
  if (doc.title) out.metadata.title = doc.title;
  out.notes.push("HTML tags, scripts and styles were stripped; only visible text is shown.");
}

function extractNotebook(bytes: Uint8Array, out: ExtractedDocument): void {
  const { text } = decodeText(bytes);
  const nb = JSON.parse(text) as {
    cells?: Array<{ cell_type?: string; source?: string[]; outputs?: Array<Record<string, unknown>> }>;
    metadata?: { kernelspec?: { display_name?: string } };
  };
  const cells = nb.cells ?? [];
  out.metadata.cells = cells.length;
  out.metadata.kernel = nb.metadata?.kernelspec?.display_name ?? "unknown";

  const parts: string[] = [];
  for (const [i, cell] of cells.slice(0, MAX_NOTEBOOK_CELLS).entries()) {
    parts.push(`--- Cell ${i} [${cell.cell_type ?? "unknown"}] ---\n${(cell.source ?? []).join("")}`);
    // Outputs matter: a traceback in cell 12 is usually the whole reason the
    // notebook is being read.
    for (const o of (cell.outputs ?? []).slice(0, 3)) {
      const chunk =
        Array.isArray(o.text) ? (o.text as string[]).join("")
        : Array.isArray(o.traceback) ? (o.traceback as string[]).join("\n")
        : "";
      if (chunk.trim()) parts.push(`  Output: ${chunk.slice(0, 1000)}`);
    }
  }
  out.text = parts.join("\n\n");
  out.extractor = "ipynb";
  if (cells.length > MAX_NOTEBOOK_CELLS) {
    out.truncated = true;
    out.notes.push(`Showing the first ${MAX_NOTEBOOK_CELLS} of ${cells.length} cells.`);
  }
}

/* ── OOXML ───────────────────────────────────────────────────────────────── */

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** Parse an XML string with DOMParser, throwing on a parser-error node. */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Malformed XML");
  }
  return doc;
}

async function extractDocx(
  bytes: Uint8Array, out: ExtractedDocument, type: DetectedType,
): Promise<void> {
  if (type.ext === ".rtf") { extractRtf(bytes, out); return; }
  if (type.ext === ".doc") {
    out.notes.push(
      "Word 97-2003 (.doc) is a legacy binary format with no reliable open " +
      "parser. Re-save it as .docx or PDF — both are read fully here.",
    );
    return;
  }

  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) { out.notes.push("No document body found inside this .docx."); return; }

  const doc = parseXml(xml);
  const paragraphs: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(NS_W, "p"))) {
    // A paragraph's text is split across runs (one per formatting change), so
    // the runs are joined; w:tab and w:br are the only whitespace elements
    // that carry meaning.
    let line = "";
    for (const node of Array.from(p.getElementsByTagName("*"))) {
      const local = node.localName;
      if (local === "t") line += node.textContent ?? "";
      else if (local === "tab") line += "\t";
      else if (local === "br") line += "\n";
    }
    if (line.trim()) paragraphs.push(line.trim());
  }
  out.text = paragraphs.join("\n\n");
  out.extractor = "jszip+DOMParser";
  out.metadata.paragraphs = paragraphs.length;
  out.notes.push(
    "Read in the browser — heading levels and table layout are flattened to " +
    "plain paragraphs. The document's wording is complete.",
  );
}

function extractRtf(bytes: Uint8Array, out: ExtractedDocument): void {
  const { text } = decodeText(bytes);
  // RTF is text wrapped in escapes, so stripping genuinely reads it — unlike
  // the PDF case, this is not a heuristic that invents plausible content.
  let s = text.replace(
    /\{\\\*?\\(?:pict|object|fonttbl|colortbl|stylesheet|info)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "");
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\par[d]?\b/g, "\n").replace(/\\tab\b/g, "\t");
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, "").replace(/[{}]/g, "");
  out.text = s.replace(/\n{3,}/g, "\n\n").trim();
  out.extractor = "rtf-strip";
}

async function extractXlsx(
  bytes: Uint8Array, out: ExtractedDocument, type: DetectedType,
): Promise<void> {
  // SheetJS reads .xls as well as .xlsx, so the legacy format works here even
  // though the Python side has to refuse it.
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  const names = wb.SheetNames.slice(0, MAX_SHEETS);
  const blocks: string[] = [];
  for (const name of names) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    const rows = csv.split("\n").slice(0, MAX_SHEET_ROWS);
    blocks.push(`--- Sheet: ${name} ---\n${rows.join("\n")}`);
  }
  out.text = blocks.join("\n\n");
  out.extractor = "sheetjs";
  out.metadata.sheets = wb.SheetNames.length;
  if (wb.SheetNames.length > names.length) {
    out.truncated = true;
    out.notes.push(`Showing ${names.length} of ${wb.SheetNames.length} sheets.`);
  }
  if (type.ext === ".xls") out.notes.push("Legacy .xls read via SheetJS — values only.");
}

async function extractPptx(bytes: Uint8Array, out: ExtractedDocument, type: DetectedType): Promise<void> {
  if (type.ext === ".ppt") {
    out.notes.push(
      "PowerPoint 97-2003 (.ppt) is a legacy binary format. Re-save it as " +
      ".pptx or PDF and I can read it.",
    );
    return;
  }
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  // slide2.xml sorts before slide10.xml lexically, so slides are ordered by
  // the NUMBER in the filename or the deck comes out shuffled.
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));

  const blocks: string[] = [];
  for (const [i, file] of slideFiles.slice(0, MAX_SLIDES).entries()) {
    const xml = await zip.file(file)!.async("string");
    const doc = parseXml(xml);
    const texts = Array.from(doc.getElementsByTagNameNS(NS_A, "t"))
      .map((t) => t.textContent ?? "")
      .filter((t) => t.trim());
    blocks.push(`--- Slide ${i + 1} ---\n${texts.join("\n")}`);
  }
  out.text = blocks.join("\n\n");
  out.extractor = "jszip+DOMParser";
  out.metadata.slides = slideFiles.length;
  out.notes.push("Read in the browser — speaker notes are not included.");
}

/* ── PDF ─────────────────────────────────────────────────────────────────── */

async function extractPdf(bytes: Uint8Array, out: ExtractedDocument): Promise<void> {
  const pdfjs = await import("pdfjs-dist");
  // Bundler-resolved worker URL. Without this pdfjs tries to fetch a worker
  // from a path that doesn't exist under Next's asset pipeline and throws.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  // pdfjs takes ownership of the buffer it is given and detaches it, which
  // would corrupt the caller's copy — hand it a slice.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  out.metadata.pages = doc.numPages;
  out.extractor = "pdfjs";

  const pages: string[] = [];
  const limit = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= limit; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s{3,}/g, "  ")
      .trim();
    if (text) pages.push(`--- Page ${i} ---\n${text}`);
  }
  out.text = pages.join("\n\n");

  if (doc.numPages > limit) {
    out.truncated = true;
    out.notes.push(`Read the first ${limit} of ${doc.numPages} pages.`);
  }
  if (!out.text.trim()) {
    // The case that matters: a scan or an image export has zero extractable
    // characters, and a text-only pipeline reports it as an empty document.
    out.notes.push(
      "This PDF has no text layer — it is a scan or an image export, so there " +
      "is nothing to extract as text.",
    );
    // Rasterise the first few pages so it can be read visually. pdfjs already
    // has the document parsed; rendering is the same work the server does with
    // PyMuPDF, and without it a scanned spec sitting in the user's repo is
    // simply unreadable rather than merely awkward.
    const rendered = await renderPdfPages(doc, limit);
    if (rendered.length > 0) {
      out.images = rendered;
      out.notes.push(
        `Rendered the first ${rendered.length} page(s) to images so they can ` +
        `be read visually.`,
      );
    } else {
      out.notes.push(
        "Page rendering is unavailable in this browser, so this document " +
        "cannot be read in its current form. Ask the user for a text-based " +
        "version, or run OCR on it.",
      );
    }
  }
}

/** Pages a scanned PDF contributes as images. Small: each one is a full image
 *  in the request, and the model needs the first pages far more than page 30. */
const MAX_PDF_RENDER_PAGES = 3;

/**
 * Rasterise pages to PNG via canvas.
 *
 * 144 DPI equivalent (scale 2 against pdfjs's 72 DPI unit) — the point where
 * body text in a scan stays legible. Falls back to a smaller scale when the
 * result would exceed the vision size cap, and gives up quietly rather than
 * throwing: a failed render costs a note, not the read.
 */
async function renderPdfPages(
  doc: { numPages: number; getPage: (n: number) => Promise<unknown> },
  pageCount: number,
): Promise<ExtractedImage[]> {
  const out: ExtractedImage[] = [];
  const total = Math.min(pageCount, MAX_PDF_RENDER_PAGES);

  for (let i = 1; i <= total; i++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = (await doc.getPage(i)) as any;
      let blob: Blob | null = null;
      for (const scale of [2, 1.3]) {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) break;
        await page.render({ canvasContext: ctx, viewport }).promise;
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png"),
        );
        if (blob && blob.size <= MAX_IMAGE_BYTES) break;
        blob = null;   // too big at this scale — try smaller
      }
      if (!blob) continue;
      out.push({
        mime_type: "image/png",
        data: toBase64(new Uint8Array(await blob.arrayBuffer())),
        filename: `page ${i}`,
      });
    } catch {
      // One unrenderable page must not lose the others.
    }
  }
  return out;
}

/* ── Images, archives, media ─────────────────────────────────────────────── */

function toBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) blows the call-stack argument limit
  // somewhere around 100 KB, which is smaller than most screenshots.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function extractImage(
  bytes: Uint8Array, out: ExtractedDocument, type: DetectedType, path: string,
): Promise<void> {
  out.extractor = "passthrough";
  const name = path.split("/").pop() ?? "image";

  // Formats no provider accepts inline (BMP, TIFF, HEIC, ICO) are converted
  // rather than refused. The server does this with Pillow; the browser has an
  // image decoder built in, so a .bmp in the user's repo is readable here too
  // instead of being reported as an unsupported format.
  let payload = bytes;
  let mime = type.mime;
  if (!VISION_MIME.has(mime)) {
    const converted = await convertImage(bytes, mime);
    if (!converted) {
      out.notes.push(
        `${type.label} could not be converted to a format the model accepts. ` +
        `Re-save it as PNG or JPEG.`,
      );
      return;
    }
    payload = converted;
    mime = "image/png";
    out.notes.push(`Converted from ${type.label} to PNG so it could be read.`);
  }

  if (payload.length > MAX_IMAGE_BYTES) {
    const smaller = await downscaleImage(payload, mime);
    if (!smaller) {
      out.notes.push(
        `Image is ${payload.length.toLocaleString()} bytes, over the ` +
        `${MAX_IMAGE_BYTES.toLocaleString()}-byte limit for inline viewing, ` +
        `and could not be downscaled.`,
      );
      return;
    }
    payload = smaller;
    mime = "image/jpeg";
    out.notes.push("Downscaled to fit the size limit.");
  }

  out.images.push({ mime_type: mime, data: toBase64(payload), filename: name });
}

/** Decode with the browser's own image pipeline and re-encode as PNG.
 *  Returns null when the browser cannot decode the format either. */
async function convertImage(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  return rasterise(bytes, mime, "image/png");
}

/** Fit an oversized image under the vision cap: JPEG at 2048px long edge,
 *  the point where screenshot text starts to suffer. */
async function downscaleImage(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  return rasterise(bytes, mime, "image/jpeg", 2048);
}

async function rasterise(
  bytes: Uint8Array, sourceMime: string, targetMime: string, maxEdge?: number,
): Promise<Uint8Array | null> {
  let url: string | null = null;
  try {
    // `bytes.buffer` is typed ArrayBufferLike (it could be a SharedArrayBuffer),
    // which BlobPart rejects. Copying into a fresh Uint8Array gives a plain
    // ArrayBuffer and costs one memcpy on a path that is already decoding an
    // image.
    const blob = new Blob([new Uint8Array(bytes)], { type: sourceMime });
    // createImageBitmap decodes anything the browser can display, including
    // formats <img> handles but canvas APIs don't expose directly.
    let width: number, height: number;
    let source: CanvasImageSource;
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width; height = bitmap.height; source = bitmap;
    } else {
      url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode failed"));
        img.src = url!;
      });
      width = img.naturalWidth; height = img.naturalHeight; source = img;
    }
    if (!width || !height) return null;

    let scale = 1;
    if (maxEdge && Math.max(width, height) > maxEdge) {
      scale = maxEdge / Math.max(width, height);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), targetMime, targetMime === "image/jpeg" ? 0.8 : undefined),
    );
    if (!outBlob) return null;
    return new Uint8Array(await outBlob.arrayBuffer());
  } catch {
    return null;   // unsupported format, tainted canvas, or no DOM — report, don't throw
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function extractArchive(bytes: Uint8Array, out: ExtractedDocument): Promise<void> {
  const JSZip = (await import("jszip")).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    out.notes.push("This archive format cannot be listed in the browser (only ZIP can).");
    return;
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  out.metadata.entries = entries.length;
  out.text = entries.slice(0, MAX_ARCHIVE_ENTRIES).map((f) => f.name).join("\n");
  out.extractor = "jszip";
  // Never auto-extracted: that is how a small upload becomes gigabytes on disk
  // (a zip bomb) and how `../../` entries escape the folder (Zip Slip).
  out.notes.push(
    "Archive contents are LISTED, not extracted. Ask me to read a specific " +
    "entry and I will extract just that one.",
  );
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    out.truncated = true;
    out.notes.push(`Showing ${MAX_ARCHIVE_ENTRIES} of ${entries.length} entries.`);
  }
}

function extractMedia(out: ExtractedDocument, type: DetectedType): void {
  out.extractor = "none";
  const medium = type.kind === "video" ? "video" : "audio";
  out.notes.push(
    `This is ${medium}. I cannot watch or listen to it — no transcript or ` +
    `frames were extracted, and none are available.`,
  );
  out.notes.push(
    "To act on its contents: paste the relevant quotes, or attach screenshots " +
    "of the moments that matter (images ARE read).",
  );
}
