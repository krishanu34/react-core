"""
Input Ingestion

Whatever the user attaches to a request — files, images, or just a plain text
question with nothing attached — gets normalized through here before the agent
ever sees it.

Two things happen to every upload:

  1. It is SAVED, byte-for-byte and unmodified, to
     .devaccel/{thread_id}/input/{filename} (see agents/workspace_paths.py for
     why input/ is separate from workspace/ and output/). The bytes are kept
     whatever they are — this is the user's file, and a later tool, a later
     message, or the user themselves may need it exactly as uploaded.

  2. It is EXTRACTED — parsed into text the model can read, images it can see,
     or an explicit note saying why neither is possible (ingestion/).

Why both, and why extraction is not left to the agent: it used to be. The
agent was handed a list of filenames and expected to call read_file on the
ones it cared about. That failed for two compounding reasons — read_file could
not parse most document formats anyway, and even when it can, "the user
attached this, so read it" costs a whole extra agent step per attachment, and
the model frequently answers from the filename alone without spending it. If a
user attaches a document, they are asking about the document. It goes into the
first message.

What the model gets is a DIGEST, not the whole file: a bounded preview per
attachment, plus the saved path. The full text is one read_file away, which is
the model's own decision to spend context on.

Saving to disk (rather than holding bytes in memory for one request) is what
makes "the file I uploaded earlier" work on a later message in the thread, and
what lets any path-taking tool operate on an upload with no special-casing.
"""

import os
import re
from dataclasses import dataclass, field
from typing import List

from ingestion import ExtractedContent, detect, extract, limits
from utils.logger import get_logger

log = get_logger(__name__)


# Filenames are taken from the client, which means they can contain anything —
# including "../../etc/passwd" style path traversal. This strips that down to a
# safe basename before ever joining it onto a real filesystem path.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")

# Windows refuses these as filenames regardless of extension, and a request
# that sanitises down to one of them would fail on open() rather than at
# validation — a confusing 500 instead of a saved file with a boring name.
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

# Filesystems cap a single component around 255 bytes; leave room for the
# de-duplication suffix appended below.
_MAX_NAME_LEN = 200


def _sanitize_filename(name: str) -> str:
    """
    Reduce an arbitrary client-supplied filename to something safe to join onto
    a directory path: take only the basename component (no directory
    traversal), strip any character that isn't alphanumeric, dot, underscore or
    hyphen, then defuse the remaining filesystem-level surprises (leading dots,
    Windows reserved names, over-long components).
    """
    # Backslash is a separator on Windows but a legal filename character on
    # POSIX, so basename() alone leaves "..\\..\\evil" intact on Linux.
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    # Trim leading/trailing dots BEFORE substitution, not after: the
    # substitution turns spaces into underscores, so a later strip(". ") can no
    # longer see them and "   ...   " survives as "___...___".
    base = base.strip(". ") or "upload"

    cleaned = _UNSAFE_CHARS.sub("_", base)
    # Nothing but separators left (e.g. the name was "..." or "///") — there is
    # no filename in there to preserve.
    if not cleaned.strip("._"):
        cleaned = "upload"

    stem, ext = os.path.splitext(cleaned)
    if stem.lower() in _RESERVED_NAMES:
        stem = f"{stem}_file"
    if len(stem) > _MAX_NAME_LEN:
        stem = stem[:_MAX_NAME_LEN]
    return f"{stem}{ext[:20]}" or "upload"


@dataclass
class SavedInput:
    """One uploaded file, after being written to input/ and parsed."""
    original_filename: str
    saved_path: str
    size_bytes: int
    content_type: str = "application/octet-stream"      # what the CLIENT claimed
    detected_type: str = "application/octet-stream"     # what the BYTES say
    kind: str = "binary"
    label: str = ""
    extracted: ExtractedContent = None
    error: str = ""
    # Where the CLIENT put its own copy, when it has one (.devaccel/input/… in
    # the user's workspace). This is the path quoted to the model, because
    # read_file is a client-executed tool: it runs on the user's machine and
    # cannot resolve `saved_path`, which is on the server.
    client_path: str = ""

    @property
    def model_path(self) -> str:
        """The path to show the model — the one its tools can actually open."""
        return self.client_path or self.saved_path

    @property
    def images(self) -> list:
        """Vision-ready payloads, in the dict shape the agent loop accepts."""
        if self.extracted is None:
            return []
        return [image.to_dict() for image in self.extracted.images]

    def digest(self) -> str:
        """The block describing this attachment in the first user message."""
        header = f"### {self.original_filename}\n(read it with: read_file(\"{self.model_path}\"))"
        if self.error:
            return f"{header}\n{self.error}"
        if self.extracted is None:
            return f"{header}\n{self.label or 'Saved.'}"
        return self.extracted.render(header=header, limit=limits.max_digest_chars())

    def to_event(self) -> dict:
        """What the client is told over SSE about this upload."""
        return {
            "original_filename": self.original_filename,
            "path": self.model_path,
            "server_path": self.saved_path,
            "client_path": self.client_path,
            "size_bytes": self.size_bytes,
            "content_type": self.detected_type,
            "declared_content_type": self.content_type,
            "kind": self.kind,
            "label": self.label,
            "extracted_chars": len(self.extracted.text) if self.extracted else 0,
            "images": len(self.extracted.images) if self.extracted else 0,
            "notes": self.extracted.notes if self.extracted else [],
            "error": self.error,
        }


@dataclass
class IngestResult:
    """Everything one request's uploads produced."""
    files: List[SavedInput] = field(default_factory=list)
    images: List[dict] = field(default_factory=list)   # vision payloads, capped
    rejected: List[str] = field(default_factory=list)  # human-readable reasons

    def digest(self) -> str:
        """The '## Attached files' block appended to the user's message.

        Empty string when nothing was attached, so the caller can concatenate
        unconditionally.
        """
        if not self.files and not self.rejected:
            return ""

        parts = ["\n\n## Attached files\n"
                 "The user attached these with their message. Their contents "
                 "are below — treat them as part of the request. The full "
                 "file is at the saved path; call read_file on it when you "
                 "need more than the preview shown here."]
        parts.extend(saved.digest() for saved in self.files)
        if self.images:
            parts.append(
                f"\n{len(self.images)} image(s) from these attachments are "
                f"embedded in this message — look at them directly."
            )
        if self.rejected:
            parts.append("\n### Not accepted\n" + "\n".join(
                f"- {reason}" for reason in self.rejected
            ))
        return "\n\n".join(parts)


def save_uploaded_files(input_dir: str, uploads: List[dict]) -> List[SavedInput]:
    """Back-compatible entry point: write every upload and parse it.

    uploads: [{"filename": "photo.png", "content": b"...", "content_type": "image/png"}]

    Prefer ingest_uploads() — it also enforces the per-request byte ceiling and
    collects the vision payloads. This wrapper stays because it is the
    published shape of this module.
    """
    return ingest_uploads(input_dir, uploads).files


def ingest_uploads(input_dir: str, uploads: List[dict],
                   client_paths: dict = None) -> IngestResult:
    """
    Save and parse every upload in one request.

    `client_paths` maps an original filename to where the CLIENT saved its own
    copy (in the user's workspace). When present, that is the path quoted to
    the model: read_file is client-executed, so the server's copy is not a path
    its tools can open. The server copy still exists — extraction needs the
    bytes — but it is temporary (see router/agent_stream.py, which deletes it
    when the run ends).

    Oversized files are REJECTED with a reason rather than silently dropped or
    silently truncated: a user who attached a 900 MB video needs to be told the
    agent never saw it, not left to infer it from an answer that ignores it.

    If two uploads sanitize down to the same name (e.g. "a/photo.png" and
    "a\\photo.png" both becoming "photo.png"), later ones get a numeric suffix
    so nothing is silently overwritten.
    """
    result = IngestResult()
    used_names = set()
    request_bytes = 0

    for upload in uploads:
        original = upload.get("filename") or "upload"
        content = upload.get("content", b"") or b""
        declared = upload.get("content_type") or "application/octet-stream"

        if len(content) > limits.max_file_bytes():
            result.rejected.append(
                f"{original} — {len(content):,} bytes, over the "
                f"{limits.max_file_bytes():,}-byte per-file limit. It was NOT "
                f"saved or read."
            )
            log.info("Upload rejected (too large): %s (%d bytes)", original, len(content))
            continue

        request_bytes += len(content)
        if request_bytes > limits.max_request_bytes():
            result.rejected.append(
                f"{original} — this request's total upload size exceeded "
                f"{limits.max_request_bytes():,} bytes. It was NOT saved or read."
            )
            log.info("Upload rejected (request total exceeded): %s", original)
            continue

        filename = _sanitize_filename(original)
        candidate = filename
        if candidate in used_names:
            stem, ext = os.path.splitext(filename)
            suffix = 1
            while candidate in used_names:
                candidate = f"{stem}_{suffix}{ext}"
                suffix += 1
        used_names.add(candidate)
        target_path = os.path.join(input_dir, candidate)

        # Detect BEFORE writing: the detected type is what the SSE event and
        # the digest report, and it is derived from the bytes, never from the
        # client's Content-Type header (which is attacker-controlled and, even
        # in good faith, is wrong across browsers and platforms constantly).
        file_type = detect(content, original, declared)

        saved = SavedInput(
            original_filename=original,
            saved_path=target_path,
            size_bytes=len(content),
            content_type=declared,
            detected_type=file_type.media_type,
            kind=file_type.kind,
            label=file_type.label,
            client_path=str((client_paths or {}).get(original) or ""),
        )

        try:
            with open(target_path, "wb") as f:
                f.write(content)
        except OSError as e:
            saved.error = f"Could not be saved to the server: {e}"
            log.warning("Failed to save upload %s: %s", target_path, e)
            result.files.append(saved)
            continue

        # Extraction never fails a request — extract() catches its own errors
        # and reports them as notes on the returned content.
        saved.extracted = extract(content, filename=original, file_type=file_type)
        result.files.append(saved)

        if file_type.declared_type and not _types_agree(file_type, declared):
            log.info(
                "Upload %s declared %s but is %s — using the detected type",
                original, declared, file_type.media_type,
            )

        log.info(
            "Ingested %s: %s (%s, %d bytes) → %d chars, %d image(s) via %s",
            original, file_type.kind, file_type.media_type, len(content),
            len(saved.extracted.text), len(saved.extracted.images),
            saved.extracted.extractor or "none",
        )

    # Images are collected across ALL attachments and capped once, so ten
    # screenshots in one message cannot each claim the per-request budget.
    for saved in result.files:
        room = limits.max_images_per_request() - len(result.images)
        if room <= 0:
            break
        result.images.extend(saved.images[:room])

    total_images = sum(len(saved.images) for saved in result.files)
    if total_images > len(result.images):
        result.rejected.append(
            f"{total_images - len(result.images)} image(s) were saved but not "
            f"shown to the model — only {limits.max_images_per_request()} "
            f"images fit in one message. Ask me to read a specific one."
        )

    return result


def _types_agree(file_type, declared: str) -> bool:
    """Whether the client's Content-Type is consistent with what the bytes are.

    Only used for logging. A mismatch is usually a browser quirk rather than an
    attack, so it is noted and moved past — the detected type is authoritative
    either way.
    """
    declared = (declared or "").split(";")[0].strip().lower()
    if not declared or declared == "application/octet-stream":
        return True
    if declared == file_type.media_type:
        return True
    # A generic text/* claim on something we resolved to a specific text format
    # is agreement, not a conflict.
    return declared.startswith("text/") and file_type.kind in ("text", "tabular", "html")
