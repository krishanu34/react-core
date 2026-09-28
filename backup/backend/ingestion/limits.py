"""
Ingestion Limits

Every number a hostile (or merely enthusiastic) upload could use to exhaust
the server or the model's context window lives here, in one place, and every
one is overridable per deployment through the environment.

Why caps are a correctness feature and not just a safety one: the model has a
fixed context window. A 400-page PDF and a 200 MB CSV do not fail loudly when
they are too big — they silently push the user's actual question, the project
context and the conversation history out of the window, and the agent answers
worse than if the file had never been attached. Truncating at a known boundary
and SAYING SO in the text the model reads is strictly better than truncating
implicitly somewhere downstream.

The byte caps are enforced before any parser touches the bytes. That ordering
matters: zip bombs, malformed PDFs with a billion-object xref, and XML
entity-expansion attacks all do their damage inside the parser, so the parser
must never be reached with something oversized.
"""

import os


def _env_int(name: str, default: int) -> int:
    """Read a positive int from the environment, falling back on anything
    unparseable. A typo in a deployment's .env must not take the server down —
    it degrades to the documented default and the caller logs nothing, because
    the default is a perfectly good answer."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


# ── Transport-level caps (checked before parsing) ────────────────────────────

def max_file_bytes() -> int:
    """Largest single upload accepted. 25 MB covers realistic design docs,
    architecture PDFs and screen recordings; beyond that the right answer is a
    file-storage reference, not a multipart body held in RAM."""
    return _env_int("INGEST_MAX_FILE_BYTES", 25 * 1024 * 1024)


def max_request_bytes() -> int:
    """Largest total across every file in ONE request."""
    return _env_int("INGEST_MAX_REQUEST_BYTES", 100 * 1024 * 1024)


# ── Model-facing caps (how much of the extraction reaches the LLM) ───────────

def max_extracted_chars() -> int:
    """Ceiling on the text ONE file contributes. ~200k chars ≈ 50k tokens on
    this codebase's 4-chars-per-token heuristic (context/token_estimator.py) —
    large enough for a full specification document, small enough that a single
    attachment cannot own a 128k window on its own."""
    return _env_int("INGEST_MAX_EXTRACTED_CHARS", 200_000)


def max_digest_chars() -> int:
    """Ceiling on what each attachment contributes to the FIRST user message.

    Deliberately much smaller than max_extracted_chars: the digest is a preview
    that rides along unconditionally, whether or not the model cares about the
    file. The full extraction is always available through read_file, which is
    the model's own decision to spend context."""
    return _env_int("INGEST_MAX_DIGEST_CHARS", 12_000)


def max_image_bytes() -> int:
    """Largest image forwarded to the model as vision input. Base64 inflates by
    4/3, so 5 MB of PNG is ~6.7 MB of request body and roughly 1-2k tokens of
    image after the provider's own tiling."""
    return _env_int("INGEST_MAX_IMAGE_BYTES", 5 * 1024 * 1024)


def max_images_per_request() -> int:
    """How many images one turn may put in front of the model. Each costs real
    tokens; a folder drag-and-drop of 200 screenshots must not silently become
    a 200-image request."""
    return _env_int("INGEST_MAX_IMAGES", 8)


# ── Per-format structural caps ───────────────────────────────────────────────

def max_pdf_pages() -> int:
    """Pages of a PDF whose text is extracted."""
    return _env_int("INGEST_MAX_PDF_PAGES", 50)

def max_pdf_render_pages() -> int:
    """Pages of a SCANNED pdf (no text layer) rendered to images for vision.
    Small on purpose — each rendered page is a full image in the request."""
    return _env_int("INGEST_MAX_PDF_RENDER_PAGES", 5)

def max_sheets() -> int:
    """Worksheets read from one workbook."""
    return _env_int("INGEST_MAX_SHEETS", 20)

def max_sheet_rows() -> int:
    """Rows read per worksheet / delimited file."""
    return _env_int("INGEST_MAX_SHEET_ROWS", 500)

def max_sheet_cols() -> int:
    """Columns read per worksheet row."""
    return _env_int("INGEST_MAX_SHEET_COLS", 50)

def max_slides() -> int:
    """Slides read from one presentation."""
    return _env_int("INGEST_MAX_SLIDES", 200)

def max_archive_entries() -> int:
    """Entries listed from an archive. Archives are LISTED, never extracted —
    see extractors.py for why."""
    return _env_int("INGEST_MAX_ARCHIVE_ENTRIES", 200)

def max_notebook_cells() -> int:
    """Cells read from one Jupyter notebook."""
    return _env_int("INGEST_MAX_NOTEBOOK_CELLS", 300)


# ── Shared helper ────────────────────────────────────────────────────────────

def clip(text: str, limit: int) -> tuple:
    """Cut `text` to `limit` chars, returning (text, was_truncated).

    Truncation is always reported to the caller so it can be stated in the text
    the model reads. Silent truncation is how an agent confidently answers
    "the document does not mention X" about a document whose second half it
    never received.
    """
    if text is None:
        return "", False
    if limit <= 0 or len(text) <= limit:
        return text, False
    return text[:limit], True
