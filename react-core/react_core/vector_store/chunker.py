"""Text chunker for the vector store — paragraph/sentence-aware."""
from __future__ import annotations

import os
import re
from typing import Iterable

_DEFAULT_CHUNK = int(os.getenv("VECTOR_CHUNK_CHARS", "1000"))
_DEFAULT_OVERLAP = int(os.getenv("VECTOR_CHUNK_OVERLAP", "100"))
_PARA_SPLIT = re.compile(r"\n\s*\n")
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def chunk_text(
    text: str,
    *,
    max_chars: int = _DEFAULT_CHUNK,
    overlap: int = _DEFAULT_OVERLAP,
) -> list[str]:
    """Split `text` into ~`max_chars`-sized chunks with `overlap`-char tails.

    Rules:
    - Prefer paragraph boundaries; fall back to sentence boundaries; fall
      back to hard character cuts.
    - Overlap is applied by trailing characters of the previous chunk.
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    pieces: list[str] = []
    buf = ""
    for para in _split_keep_boundaries(text, _PARA_SPLIT):
        if len(buf) + len(para) + 2 <= max_chars:
            buf = f"{buf}\n\n{para}" if buf else para
            continue
        if buf:
            pieces.append(buf)
            buf = ""
        # Paragraph itself may be huge — sentence split.
        if len(para) <= max_chars:
            buf = para
            continue
        for sent in _split_keep_boundaries(para, _SENT_SPLIT):
            if len(buf) + len(sent) + 1 <= max_chars:
                buf = f"{buf} {sent}" if buf else sent
            else:
                if buf:
                    pieces.append(buf)
                    buf = ""
                # Sentence still too big — hard cut.
                for i in range(0, len(sent), max_chars):
                    pieces.append(sent[i : i + max_chars])
    if buf:
        pieces.append(buf)

    # Apply overlap by prepending the tail of the previous chunk.
    if overlap <= 0 or len(pieces) < 2:
        return pieces
    stitched: list[str] = [pieces[0]]
    for i in range(1, len(pieces)):
        prev_tail = pieces[i - 1][-overlap:]
        stitched.append(f"{prev_tail}\n{pieces[i]}")
    return stitched


def _split_keep_boundaries(text: str, pattern: re.Pattern[str]) -> Iterable[str]:
    parts = pattern.split(text)
    for p in parts:
        if p.strip():
            yield p.strip()
