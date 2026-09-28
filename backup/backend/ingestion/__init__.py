"""
Ingestion — the single place that turns an arbitrary file into something an
LLM can actually reason about.

Every path that puts user content in front of the model goes through here:

    router/agent_stream.py     files attached to a chat message
    tools/read_file_tool.py    a file the agent decides to read
    tools/batch_read_files_tool.py

Before this module existed, each of those made its own guess. The upload path
branched on the browser's `content_type` and, for anything not `image/*`, gave
the model a filename and nothing else. read_file kept a hardcoded set of
"binary" extensions it refused outright, plus a regex over raw PDF bytes that
produced noise on any compressed PDF. So a user attaching the .docx that
contains their entire requirement — the single most common real attachment —
got "Binary file. Cannot display content."

The contract here is deliberately small:

    detect(data, filename, declared_type) -> FileType    what is this?
    extract(data, filename)              -> ExtractedContent   make it legible
    extract_file(path)                   -> ExtractedContent   same, from disk

ExtractedContent always carries text, vision-ready images, or an explicit note
saying why neither exists. Callers render it with `.render()` and never branch
on format themselves.

Adding a format means: a signature or extension in detect.py, and an entry in
extractors._HANDLERS. Nothing else changes.
"""

from .content import ExtractedContent, ImageBlock, decode_text
from .detect import (
    KIND_ARCHIVE, KIND_AUDIO, KIND_BINARY, KIND_DOCUMENT, KIND_EMAIL,
    KIND_HTML, KIND_IMAGE, KIND_NOTEBOOK, KIND_PDF, KIND_PRESENTATION,
    KIND_SPREADSHEET, KIND_TABULAR, KIND_TEXT, KIND_VIDEO,
    FileType, detect, detect_path, looks_like_text,
)
from .extractors import extract, extract_file
from . import limits

__all__ = [
    "ExtractedContent", "ImageBlock", "FileType",
    "detect", "detect_path", "extract", "extract_file",
    "decode_text", "looks_like_text", "limits",
    "KIND_TEXT", "KIND_TABULAR", "KIND_HTML", "KIND_NOTEBOOK", "KIND_EMAIL",
    "KIND_IMAGE", "KIND_PDF", "KIND_DOCUMENT", "KIND_SPREADSHEET",
    "KIND_PRESENTATION", "KIND_ARCHIVE", "KIND_AUDIO", "KIND_VIDEO",
    "KIND_BINARY",
]
