"""
Extracted Content

The one shape every extractor returns, whatever went in. A .docx, a scanned
PDF, a screenshot and a .mp4 all come out of ingestion as an ExtractedContent,
so callers (the upload path, read_file, batch_read_files) never branch on
format — they branch on what came back: text, images, or an honest note
saying why neither is available.

`notes` is the part that stops the agent lying. When extraction is partial or
impossible, the reason goes in notes and notes go into the text the model
reads. An agent told "PDF has no text layer (scanned) — 3 pages rendered as
images instead" behaves correctly; an agent handed an empty string concludes
the document is empty and confidently says so.
"""

import base64
from dataclasses import dataclass, field
from typing import List, Optional

from .limits import clip, max_extracted_chars


@dataclass
class ImageBlock:
    """One image ready to go to a vision model."""
    media_type: str            # image/png | image/jpeg | image/gif | image/webp
    data_b64: str
    source: str = ""           # filename or "page 3 of spec.pdf"
    width: Optional[int] = None
    height: Optional[int] = None

    @property
    def data_url(self) -> str:
        """The `data:` URL form the OpenAI chat-completions image_url part
        wants. Anthropic-style APIs take media_type + data separately, which is
        why both are kept rather than only the URL."""
        return f"data:{self.media_type};base64,{self.data_b64}"

    def to_dict(self) -> dict:
        """The dict shape the agent loop already accepts for vision input
        (see agents/tool_use_agent.py) — keys are `mime_type`, `data`,
        `filename`, so this stays a drop-in for the existing plumbing."""
        return {
            "mime_type": self.media_type,
            "data": self.data_b64,
            "filename": self.source,
        }

    @classmethod
    def from_bytes(cls, data: bytes, media_type: str, source: str = "",
                   width: int = None, height: int = None) -> "ImageBlock":
        return cls(
            media_type=media_type,
            data_b64=base64.b64encode(data).decode("ascii"),
            source=source,
            width=width,
            height=height,
        )


@dataclass
class ExtractedContent:
    """The result of trying to make a file legible to a model."""

    kind: str                                   # detect.KIND_*
    label: str                                  # "Word document (.docx)"
    media_type: str = "application/octet-stream"
    text: str = ""                              # "" when nothing was extractable
    images: List[ImageBlock] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)  # pages, sheets, duration, …
    notes: List[str] = field(default_factory=list)  # limits, failures, next steps
    truncated: bool = False
    extractor: str = ""                         # which backend produced the text
    size_bytes: int = 0

    @property
    def has_content(self) -> bool:
        return bool(self.text.strip()) or bool(self.images)

    def note(self, message: str) -> "ExtractedContent":
        """Record a limitation. Chainable so extractors read as one expression."""
        if message and message not in self.notes:
            self.notes.append(message)
        return self

    def finalize(self, limit: int = None) -> "ExtractedContent":
        """Apply the global per-file text ceiling. Called once, by the
        dispatcher, so no extractor has to remember to do it."""
        cap = max_extracted_chars() if limit is None else limit
        self.text, was_clipped = clip(self.text, cap)
        if was_clipped:
            self.truncated = True
            self.note(
                f"Text truncated at {cap:,} characters (the file is larger). "
                f"Ask for a specific section by name/heading to see more."
            )
        return self

    def render(self, header: str = "", limit: int = None) -> str:
        """Turn this into the block of text the model actually reads.

        Structure is fixed on purpose — header, metadata line, notes, then
        content — so the model learns one layout across every format instead
        of a different one per extractor.
        """
        body, was_clipped = clip(self.text, limit) if limit else (self.text, False)

        lines = []
        if header:
            lines.append(header)

        facts = [self.label]
        if self.size_bytes:
            facts.append(_human_size(self.size_bytes))
        for key in ("pages", "sheets", "slides", "rows", "cells", "entries",
                    "duration", "dimensions", "encoding"):
            if self.metadata.get(key):
                facts.append(f"{key}: {self.metadata[key]}")
        lines.append(" · ".join(str(f) for f in facts))

        if self.images:
            lines.append(
                f"[{len(self.images)} image(s) from this file are attached to "
                f"this message and visible to you.]"
            )

        for note in self.notes:
            lines.append(f"NOTE: {note}")
        if was_clipped:
            lines.append("NOTE: preview truncated — read the file for the full text.")

        if body.strip():
            lines.append("")
            lines.append(body)
        elif not self.images:
            lines.append("")
            lines.append("(No readable text could be extracted from this file.)")

        return "\n".join(lines)


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / (1024 * 1024 * 1024):.2f} GB"


# ── Text decoding ────────────────────────────────────────────────────────────

# Ordered by how confident a successful decode makes us. UTF-8 is strict, so a
# clean decode is near-proof; cp1252 and latin-1 accept almost any byte, so
# they come last and latin-1 (which accepts EVERY byte) is the terminal
# fallback that guarantees this function always returns something.
#
# UTF-16 is deliberately NOT in this list. It "succeeds" on ANY byte string of
# even length — `"café naïve".encode("cp1252")` decodes to CJK gibberish
# without raising — so trying it before cp1252 corrupts every Windows-authored
# text file. It is reached only via a byte-order mark, or via the NUL-density
# check below, which is what actually distinguishes it.
_ENCODINGS = ("utf-8", "cp1252", "latin-1")

_BOMS = (
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe\x00\x00", "utf-32"),
    (b"\x00\x00\xfe\xff", "utf-32"),
    (b"\xff\xfe", "utf-16"),
    (b"\xfe\xff", "utf-16"),
)


def decode_text(data: bytes) -> tuple:
    """Decode bytes to str, returning (text, encoding_name).

    A byte-order mark wins outright — it is the file declaring its own
    encoding. Otherwise each candidate is tried strictly, so a file that is
    genuinely cp1252 is not silently mangled by a lossy UTF-8 decode with
    replacement characters (the previous behaviour everywhere in this codebase,
    which turned every non-ASCII character in a Windows-authored document into
    U+FFFD).
    """
    if not data:
        return "", "utf-8"

    for bom, encoding in _BOMS:
        if data.startswith(bom):
            try:
                return data.decode(encoding), encoding
            except (UnicodeDecodeError, LookupError):
                break

    # BOM-less UTF-16 (common in Windows tooling output). The tell is NUL
    # bytes at every second position — ASCII-range characters encode as
    # `X\x00` (LE) or `\x00X` (BE). A single-byte encoding never does this.
    sample = data[:4096]
    if b"\x00" in sample:
        evens = sample[0::2].count(0)
        odds = sample[1::2].count(0)
        half = len(sample) // 2
        if half and (odds > half * 0.3 or evens > half * 0.3):
            for encoding in ("utf-16-le", "utf-16-be"):
                try:
                    return data.decode(encoding), encoding
                except UnicodeDecodeError:
                    continue

    for encoding in _ENCODINGS:
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue

    # Unreachable in practice (latin-1 maps all 256 byte values), but a
    # guaranteed return beats an exception escaping into a tool call.
    return data.decode("utf-8", errors="replace"), "utf-8 (lossy)"
