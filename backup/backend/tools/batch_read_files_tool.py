"""
Batch Read Files Tool

Reads the first N lines of MULTIPLE files in a SINGLE tool call.
This is the key tool that makes large workspace analysis possible.

Without this:  100 files × 1 read_file call = 100 steps (impossible)
With this:     100 files ÷ 10 per batch = 10 steps (easy)

This is how Claude Code handles large projects — it doesn't read
files one at a time. It processes them in batches, extracts what
it needs, writes partial results, and moves on.

Each file gets just the first N lines (default 25), which is enough
to see the module docstring, imports, and first class/function
definition — everything needed to understand the file's purpose.
"""

from pathlib import Path

from .base_tool import BaseTool
from context.read_tracker import mark_read
from ingestion import KIND_TEXT, decode_text, detect_path, extract_file

MAX_FILES_PER_BATCH = 15

# How much extracted text one non-text file contributes to a batch. A batch is
# a SURVEY — 15 files at a glance — so a 40-page PDF in it must not crowd out
# the other 14. read_file on that one path is the way to see all of it.
BATCH_EXTRACT_CHARS = 4000


class BatchReadFilesTool(BaseTool):

    name = "batch_read_files"

    description = (
        "Read the first N lines of MULTIPLE files in ONE call. "
        "Use this for workspace analysis to understand many files "
        "efficiently. Pass a list of file paths and get back the "
        "first 25 lines of each file. Much faster than calling "
        "read_file one file at a time. Max 15 files per batch."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "List of file paths (relative to project root) to read. "
                        "Example: ['agents/orchestrator.py', 'tools/registry.py', 'main.py']"
                    )
                },
                "lines": {
                    "type": "integer",
                    "description": (
                        "Number of lines to read from each file. Default: 25. "
                        "25 lines captures docstring + imports + first definition."
                    )
                }
            },
            "required": ["paths"]
        }

    async def run(self, paths, lines=25):
        if not isinstance(paths, list):
            return {"error": "paths must be a list of file paths"}

        if len(paths) > MAX_FILES_PER_BATCH:
            return {
                "error": f"Too many files in one batch (got {len(paths)}, max {MAX_FILES_PER_BATCH}). "
                         f"Split into smaller batches."
            }

        results = []

        for rel_path in paths:
            file_path = Path(self._resolve_path(rel_path))
            entry = {"path": rel_path}

            if not file_path.exists():
                entry["error"] = "File not found"
                results.append(entry)
                continue

            if file_path.is_dir():
                entry["error"] = "Is a directory, not a file"
                results.append(entry)
                continue

            file_type = detect_path(str(file_path))

            # Documents get parsed, not skipped. A batch over an input/ folder
            # of attachments used to report every .pdf and .docx in it as
            # "binary" and move on, which is the same as not reading them.
            if file_type.kind != KIND_TEXT:
                try:
                    extracted = extract_file(str(file_path))
                    entry["type"] = extracted.kind
                    entry["format"] = extracted.label
                    entry["size"] = extracted.size_bytes
                    if extracted.text:
                        preview = extracted.text[:BATCH_EXTRACT_CHARS]
                        entry["content"] = preview
                        if len(extracted.text) > len(preview):
                            entry["truncated"] = True
                            entry["note"] = (
                                f"Preview only — call read_file('{rel_path}') "
                                f"for the full text."
                            )
                        mark_read(self.thread_id, rel_path)
                    if extracted.notes:
                        entry["notes"] = extracted.notes
                    # Images are NOT sent to the vision buffer from here: a
                    # 15-file batch would blow the per-turn image budget in one
                    # call. read_file on the specific image is how the model
                    # asks to actually look at one.
                    if extracted.images:
                        entry["note"] = (
                            f"Contains {len(extracted.images)} viewable "
                            f"image(s) — call read_file('{rel_path}') to see them."
                        )
                except Exception as e:  # noqa: BLE001
                    entry["error"] = f"Extraction failed: {e}"
                results.append(entry)
                continue

            try:
                content_lines = _read_first_lines(file_path, lines)
                entry["lines_read"] = len(content_lines)
                entry["total_lines"] = _count_lines(file_path)
                entry["content"] = "\n".join(content_lines)
                # Read-before-overwrite (Claude Code parity): this is only a
                # partial peek (first N lines), but it's the same bar read_file
                # sets — the agent has looked at the file before writing it.
                mark_read(self.thread_id, rel_path)
            except Exception as e:
                entry["error"] = f"Read failed: {e}"

            results.append(entry)

        # Counted on what actually happened, not on which keys are present: a
        # parsed .docx now has BOTH "content" and "type", so the old
        # `"type" in r` test scored every successful extraction as a skip.
        return {
            "files_read": len([r for r in results if r.get("content")]),
            "files_skipped": len([r for r in results
                                  if "error" in r or not r.get("content")]),
            "results": results,
        }


def _read_first_lines(file_path: Path, num_lines: int) -> list:
    """Read the first N lines of a text file.

    Reads bytes and decodes through ingestion rather than opening in text mode
    with errors="replace": a cp1252 or UTF-16 file is then read correctly
    instead of arriving as a line of U+FFFD.
    """
    try:
        with open(file_path, "rb") as f:
            # 64 KB comfortably covers N lines for any realistic source file,
            # and bounds the read for a minified bundle on one enormous line.
            raw = f.read(65536)
    except OSError:
        return []
    text, _ = decode_text(raw)
    return [line.rstrip() for line in text.splitlines()[:num_lines]]


def _count_lines(file_path: Path) -> int:
    """Count total lines without reading entire file into memory."""
    try:
        with open(file_path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0
