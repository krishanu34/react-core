/**
 * attachmentSupport — what will actually happen to a file BEFORE it is sent.
 *
 * The problem this solves: a user attaches a 40 MB screen recording, waits for
 * the upload, and only then learns from the model that it cannot watch video.
 * The cost of finding out is paid in full — upload time, tokens, a wasted turn
 * — for information that was knowable from the filename.
 *
 * Claude Code never has this failure mode because it has no upload step: files
 * are already local, and Read reports what it can do at the moment it is
 * asked. Our client-server split reintroduces the gap, so the fix is to answer
 * the same question earlier — at attach time, in the composer, before a byte
 * moves.
 *
 * This is a PREVIEW, not the verdict. The server decides for real, from the
 * file's bytes (backend/ingestion/detect.py), and it is right where this is
 * wrong — a .txt full of PNG bytes is an image to the server and text to this
 * table. The preview only ever needs to be right enough to stop someone
 * uploading a video expecting it to be watched; when the two disagree the
 * server's `inputs_saved` event corrects the record.
 *
 * Keep in sync with backend/ingestion/detect.py. The duplication is deliberate
 * — the browser cannot run the Python detector, and the alternative (a
 * round-trip to classify each file before showing a chip) costs the upload
 * this exists to avoid.
 */

export type SupportLevel = "full" | "partial" | "none";

export interface AttachmentSupport {
  /** full = read completely · partial = read with a caveat · none = cannot be read */
  level: SupportLevel;
  /** Format name shown on the chip, e.g. "Word document". */
  label: string;
  /** What will happen, in the user's words. Always set for partial/none. */
  note?: string;
}

/* Extension → [level, label, note]. Grouped the way a user thinks about
   files, not the way the parser does. */
const TABLE: Record<string, [SupportLevel, string, string?]> = {
  // ── Read completely ──────────────────────────────────────────────────────
  ".txt": ["full", "Text"],
  ".md": ["full", "Markdown"],
  ".markdown": ["full", "Markdown"],
  ".rst": ["full", "reStructuredText"],
  ".log": ["full", "Log file"],
  ".json": ["full", "JSON"],
  ".jsonl": ["full", "JSON Lines"],
  ".ndjson": ["full", "JSON Lines"],
  ".yaml": ["full", "YAML"],
  ".yml": ["full", "YAML"],
  ".toml": ["full", "TOML"],
  ".xml": ["full", "XML"],
  ".csv": ["full", "CSV data"],
  ".tsv": ["full", "TSV data"],
  ".html": ["full", "HTML"],
  ".htm": ["full", "HTML"],
  ".ipynb": ["full", "Jupyter notebook"],
  ".eml": ["full", "Email"],
  ".pdf": ["full", "PDF"],
  ".docx": ["full", "Word document"],
  ".odt": ["full", "OpenDocument text"],
  ".rtf": ["full", "Rich text"],
  ".xlsx": ["full", "Excel workbook"],
  ".ods": ["full", "OpenDocument sheet"],
  ".pptx": ["full", "PowerPoint"],
  ".odp": ["full", "OpenDocument slides"],
  ".sql": ["full", "SQL"],
  ".env": ["full", "Env file"],
  ".ini": ["full", "Config"],
  ".cfg": ["full", "Config"],
  ".conf": ["full", "Config"],
  ".svg": ["full", "SVG (read as XML)"],

  // ── Images the model can look at ─────────────────────────────────────────
  ".png": ["full", "PNG image"],
  ".jpg": ["full", "JPEG image"],
  ".jpeg": ["full", "JPEG image"],
  ".gif": ["full", "GIF image"],
  ".webp": ["full", "WebP image"],

  // ── Read, but with a caveat worth stating up front ───────────────────────
  ".bmp": ["partial", "BMP image", "Converted to PNG first so it can be viewed."],
  ".tif": ["partial", "TIFF image", "Converted to PNG first so it can be viewed."],
  ".tiff": ["partial", "TIFF image", "Converted to PNG first so it can be viewed."],
  ".heic": ["partial", "HEIC image", "Converted to PNG first so it can be viewed."],
  ".ico": ["partial", "Icon", "Converted to PNG first so it can be viewed."],
  ".zip": ["partial", "ZIP archive", "Contents are LISTED, not extracted. Attach the specific files you need read."],
  ".tar": ["partial", "tar archive", "Contents are LISTED, not extracted."],
  ".gz": ["partial", "gzip archive", "Contents are LISTED, not extracted."],
  ".7z": ["partial", "7-Zip archive", "Contents are LISTED, not extracted."],
  ".rar": ["partial", "RAR archive", "Contents are LISTED, not extracted."],
  ".msg": ["partial", "Outlook message", "Body may not be readable — re-save as .eml if it matters."],

  // ── Cannot be read ───────────────────────────────────────────────────────
  ".mp4": ["none", "Video", "I can't watch video. Paste the key quotes, or attach screenshots of the moments that matter."],
  ".mov": ["none", "Video", "I can't watch video. Attach screenshots of the moments that matter."],
  ".avi": ["none", "Video", "I can't watch video. Attach screenshots of the moments that matter."],
  ".mkv": ["none", "Video", "I can't watch video. Attach screenshots of the moments that matter."],
  ".webm": ["none", "Video", "I can't watch video. Attach screenshots of the moments that matter."],
  ".wmv": ["none", "Video", "I can't watch video. Attach screenshots of the moments that matter."],
  ".mp3": ["none", "Audio", "I can't listen to audio. Paste a transcript if you have one."],
  ".wav": ["none", "Audio", "I can't listen to audio. Paste a transcript if you have one."],
  ".m4a": ["none", "Audio", "I can't listen to audio. Paste a transcript if you have one."],
  ".flac": ["none", "Audio", "I can't listen to audio. Paste a transcript if you have one."],
  ".ogg": ["none", "Audio", "I can't listen to audio. Paste a transcript if you have one."],
  ".doc": ["none", "Word 97-2003", "Legacy binary format. Re-save as .docx or PDF and I can read it fully."],
  ".xls": ["none", "Excel 97-2003", "Legacy binary format. Re-save as .xlsx or export to CSV."],
  ".ppt": ["none", "PowerPoint 97-2003", "Legacy binary format. Re-save as .pptx or PDF."],
  ".exe": ["none", "Executable", "Binary program — nothing to read."],
  ".dll": ["none", "Library", "Binary — nothing to read."],
  ".so": ["none", "Library", "Binary — nothing to read."],
  ".db": ["none", "Database file", "Binary — export the rows you need as CSV."],
  ".sqlite": ["none", "SQLite database", "Binary — export the rows you need as CSV."],
  ".ttf": ["none", "Font", "Binary — nothing to read."],
  ".otf": ["none", "Font", "Binary — nothing to read."],
  ".woff": ["none", "Font", "Binary — nothing to read."],
  ".woff2": ["none", "Font", "Binary — nothing to read."],
};

/* Source-code extensions all behave the same, so they are listed rather than
   repeated in the table above. */
const CODE_EXTENSIONS = new Set([
  ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt",
  ".go", ".rs", ".rb", ".php", ".cs", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".swift", ".m", ".mm", ".scala", ".sh", ".bash", ".zsh", ".ps1", ".bat",
  ".pl", ".r", ".jl", ".lua", ".dart", ".ex", ".exs", ".hs", ".clj", ".vue",
  ".svelte", ".css", ".scss", ".sass", ".less", ".tf", ".gradle", ".proto",
  ".graphql", ".patch", ".diff", ".cob", ".cbl", ".vb", ".asm", ".f90",
]);

/** Per-file cap the server enforces (INGEST_MAX_FILE_BYTES). Mirrored so an
 *  oversized file is flagged before it is uploaded rather than after. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What will happen to this file. Size is checked first: a supported format
 * that is too large is still not going to be read, and saying "Word document"
 * next to a file the server will refuse would be a lie of omission.
 */
export function describeAttachment(file: { name: string; size: number }): AttachmentSupport {
  if (file.size > MAX_FILE_BYTES) {
    return {
      level: "none",
      label: "Too large",
      note: `${humanSize(file.size)} exceeds the ${humanSize(MAX_FILE_BYTES)} limit — it won't be uploaded or read.`,
    };
  }

  const ext = extensionOf(file.name);
  const hit = TABLE[ext];
  if (hit) {
    const [level, label, note] = hit;
    return { level, label, note };
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return { level: "full", label: `${ext.slice(1)} source` };
  }
  // Unknown extension. The server sniffs the bytes and reads it as text if it
  // decodes cleanly, which covers Dockerfile, Makefile, .editorconfig and
  // every config format nobody thought to list — so this is "probably fine",
  // not "unsupported".
  return {
    level: "partial",
    label: ext ? `${ext.slice(1)} file` : "File",
    note: "Unrecognised type — it will be read as text if it contains text, and reported if not.",
  };
}

/** One-line summary for the composer, or null when everything is readable. */
export function summariseAttachments(
  files: Array<{ name: string; size: number }>,
): { unreadable: string[]; caveats: string[] } | null {
  const unreadable: string[] = [];
  const caveats: string[] = [];
  for (const f of files) {
    const s = describeAttachment(f);
    if (s.level === "none") unreadable.push(f.name);
    else if (s.level === "partial" && s.note && !s.note.startsWith("Unrecognised")) {
      caveats.push(f.name);
    }
  }
  return unreadable.length || caveats.length ? { unreadable, caveats } : null;
}
