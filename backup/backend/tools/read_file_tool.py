"""
Read File Tool

Reads any file the agent asks for and returns something it can actually reason
about. Text comes back with line numbers; every other format goes through
ingestion/ and comes back as extracted text, as viewable images, or as an
explicit statement of why neither is possible.

What this used to do, and why it changed: a hardcoded `_BINARY_EXTENSIONS` set
refused .docx/.xlsx/.pptx outright ("Binary file. Cannot display content."),
images returned their dimensions with the advice to "use an image viewer" —
which the model has no way to do — and PDFs were regex-scraped for `(...)`
runs out of the raw bytes, which on any Flate-compressed PDF (i.e. essentially
all of them) yields noise the model then treats as the document's contents.
Attaching a requirements .docx and asking about it was the single most common
thing a user could do, and it did not work.

Claude Code parity, feature by feature:
  - text            line-numbered, offset/limit windowing        (unchanged)
  - images          presented VISUALLY, not described            (new)
  - PDFs            per-page text; page ranges via offset/limit  (new)
  - notebooks       cells with their outputs                     (unchanged)
  - office docs     full text, tables, sheets, slides            (new)
  - unsupported     an honest message naming the limitation      (new)
"""

from pathlib import Path

from .base_tool import BaseTool
from .sensitive_guard import redact_sensitive_content
from context.permissions import check_path_permission
from context.read_tracker import mark_read
from ingestion import KIND_TEXT, detect_path, extract_file, limits

# Text files above this are windowed rather than returned whole (500 KB).
MAX_FILE_SIZE = 500_000

# Lines returned when no limit is given — Claude Code's Read default. A cap
# here is what stops one read of a generated 40k-line lockfile from consuming
# the context window that the rest of the task needs.
DEFAULT_LINE_LIMIT = 2000


class ReadFileTool(BaseTool):

    name = "read_file"

    description = (
        "Read the contents of any file. Text and code come back with line "
        "numbers (use offset/limit for large files). PDFs, Word/Excel/"
        "PowerPoint documents, CSVs, notebooks, HTML and emails are parsed to "
        "text automatically — read them directly, do NOT try to open them with "
        "a terminal command. Images are shown to you visually. For a PDF, "
        "offset/limit select a PAGE range. Use this to understand existing "
        "code and any document the user attached before making changes."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "File path relative to project root. "
                        "Examples: 'README.md', 'agents/orchestrator.py', "
                        "'.devaccel/<thread>/input/requirements.docx'"
                    )
                },
                "offset": {
                    "type": "integer",
                    "description": (
                        "Start reading from this line (1-based). For a PDF, "
                        "the first PAGE to read. Default: 1"
                    )
                },
                "limit": {
                    "type": "integer",
                    "description": (
                        "Maximum lines to return (pages, for a PDF). "
                        f"Default: {DEFAULT_LINE_LIMIT} lines / all pages."
                    )
                }
            },
            "required": ["path"]
        }

    async def run(self, path, offset=None, limit=None):
        file_path = Path(self._resolve_path(path))

        perm = check_path_permission(path, workspace=self.workspace, write=False)
        if not perm.allowed:
            return {"error": f"Permission denied: {perm.reason}"}

        if not file_path.exists():
            return {"error": f"File not found: {path}"}
        if file_path.is_dir():
            return {"error": f"'{path}' is a directory, not a file. Use list_directory instead."}

        # Read-before-overwrite (Claude Code parity): the agent has now seen
        # this path's current state — file_write may target it after this.
        mark_read(self.thread_id, path)

        file_type = detect_path(str(file_path))

        # Plain text keeps the original line-numbered path: line numbers are
        # what code_edit and the model's own references are anchored to, and
        # no extractor improves on reading a source file directly.
        if file_type.kind == KIND_TEXT and file_type.media_type != "image/svg+xml":
            return _read_text(file_path, path, offset, limit)

        return _read_extracted(file_path, path, file_type, offset, limit,
                               thread_id=self.thread_id)


def _read_text(file_path: Path, path: str, offset, limit) -> dict:
    """The original behaviour, with a default line cap added."""
    file_size = file_path.stat().st_size
    start_line = offset or 1
    effective_limit = limit or DEFAULT_LINE_LIMIT

    if file_size > MAX_FILE_SIZE and offset is None and limit is None:
        return {
            "path": path,
            "size": file_size,
            "truncated": True,
            "message": (
                f"File is large ({file_size:,} bytes). Showing the first 200 "
                f"lines. Use offset/limit to read specific sections."
            ),
            "content": _read_with_line_numbers(file_path, offset=1, limit=200),
            "total_lines": _count_lines(file_path),
        }

    content = _read_with_line_numbers(file_path, offset=start_line,
                                      limit=effective_limit)
    if content is None:
        return {"error": f"Could not read file: {path} (encoding error)"}

    total_lines = _count_lines(file_path)
    result = {
        "path": path,
        "content": redact_sensitive_content(content),
        "size": file_size,
        "total_lines": total_lines,
    }
    last_line = min(start_line + effective_limit - 1, total_lines)
    if offset or limit:
        result["showing"] = f"lines {start_line}-{last_line}"
    elif total_lines > effective_limit:
        # Silence here is how a model concludes a 5000-line file ends at 2000.
        result["truncated"] = True
        result["showing"] = f"lines 1-{effective_limit} of {total_lines}"
        result["message"] = (
            f"Showing the first {effective_limit:,} of {total_lines:,} lines. "
            f"Use offset to continue."
        )
    return result


def _read_extracted(file_path: Path, path: str, file_type, offset, limit,
                    thread_id: str) -> dict:
    """Everything that is not plain text: parse it, and hand any images to the
    vision buffer so the model sees them on its next turn."""
    extracted = extract_file(str(file_path))

    result = {
        "path": path,
        "type": file_type.kind,
        "format": extracted.label,
        "size": extracted.size_bytes,
        "extracted_by": extracted.extractor or "none",
    }
    result.update({k: v for k, v in extracted.metadata.items()
                   if k not in ("detected_by",)})

    text = extracted.text
    # For a PDF, offset/limit address PAGES — the units the document actually
    # has. Line offsets into extracted PDF text would be meaningless to a user
    # or a model looking at the original.
    if text and (offset or limit):
        text, window = _window(text, extracted.kind, offset, limit)
        if window:
            result["showing"] = window

    if text:
        result["content"] = redact_sensitive_content(text)
    if extracted.truncated:
        result["truncated"] = True
    if extracted.notes:
        result["notes"] = extracted.notes

    if extracted.images:
        from agents import vision_buffer

        queued = vision_buffer.offer(
            thread_id,
            [image.to_dict() for image in extracted.images],
            source=path,
        )
        if queued:
            result["images_attached"] = queued
            result["message"] = (
                f"{queued} image(s) from this file are attached to this "
                f"message — look at them directly."
            )
        if queued < len(extracted.images):
            result["images_dropped"] = len(extracted.images) - queued
            result["message"] = (
                f"{queued} of {len(extracted.images)} image(s) attached; the "
                f"rest exceeded this turn's image limit "
                f"({limits.max_images_per_request()}). Read the file again on "
                f"a later turn to see them."
            )

    if not extracted.has_content and "notes" not in result:
        result["message"] = f"No readable content could be extracted from {path}."
    return result


def _window(text: str, kind: str, offset, limit) -> tuple:
    """Apply offset/limit to extracted text — by page for PDFs, by line
    otherwise. Returns (text, description_of_the_window)."""
    from ingestion import KIND_PDF

    if kind == KIND_PDF and "--- Page " in text:
        pages = text.split("\n\n--- Page ")
        # split() strips the marker off every element but the first; putting it
        # back keeps page headers in the output the model reads.
        pages = [pages[0]] + [f"--- Page {p}" for p in pages[1:]]
        start = max(0, (offset or 1) - 1)
        end = start + limit if limit else len(pages)
        selected = pages[start:end]
        if not selected:
            return "", f"no pages in range (document has {len(pages)})"
        return "\n\n".join(selected), \
            f"pages {start + 1}-{min(end, len(pages))} of {len(pages)}"

    lines = text.splitlines()
    start = max(0, (offset or 1) - 1)
    end = start + limit if limit else len(lines)
    return "\n".join(lines[start:end]), \
        f"lines {start + 1}-{min(end, len(lines))} of {len(lines)}"


def _read_with_line_numbers(file_path: Path, offset: int = 1, limit: int = None) -> str:
    """
    Read a file and prepend line numbers to each line.
    Format: "  42 | def main():" — matches what developers expect.

    Decoding goes through ingestion so a cp1252 or UTF-16 source file reads
    correctly instead of arriving full of replacement characters.
    """
    from ingestion import decode_text

    try:
        with open(file_path, "rb") as f:
            raw = f.read()
    except OSError:
        return None

    text, _ = decode_text(raw)
    lines = text.splitlines()

    start_idx = max(0, offset - 1)
    lines = lines[start_idx:start_idx + limit] if limit else lines[start_idx:]

    return "\n".join(
        f"{i:>4} | {line}"
        for i, line in enumerate(lines, start=max(1, offset))
    )


def _count_lines(file_path: Path) -> int:
    """Count total lines in a file without reading it all into memory."""
    try:
        with open(file_path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0
