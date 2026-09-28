"""
File Type Detection

Answers one question: given some bytes, what IS this, and how should the agent
be shown it?

Detection order is deliberate, most trustworthy first:

  1. MAGIC BYTES — the file's own header. The only source that cannot be
     wrong, because it is the format itself.
  2. ZIP/OLE CONTAINER PROBE — .docx, .xlsx, .pptx, .odt and .jar are all
     ZIP archives with identical magic bytes, so the container's member list
     is what actually distinguishes them. Legacy .doc/.xls/.ppt are all OLE2
     compound files, likewise indistinguishable by header alone.
  3. EXTENSION — for the many text formats that have no magic bytes at all
     (.py, .md, .csv, .tf, .yaml).
  4. DECLARED CONTENT-TYPE — the browser's Content-Type header, used LAST.
  5. CONTENT HEURISTIC — no signature, no known extension: decide text vs
     binary by looking for NUL bytes and trying to decode.

Why the client's declared type is nearly last: it is attacker-controlled, and
it is wrong constantly even without an attacker. Browsers report .md as
`text/markdown` on one OS and `application/octet-stream` on another; a renamed
`invoice.pdf.exe` reports whatever the client says. The previous
implementation branched on `content_type.startswith("image/")` alone, which
means an attacker could get arbitrary bytes base64'd into an LLM request by
claiming `image/png`, and an honest user's real PNG uploaded from a client
that mislabels it was silently written to disk as an opaque blob instead.

`kind` is the routing key the rest of ingestion switches on. It is a small
closed vocabulary on purpose — extractors dispatch on it, so adding a format
means mapping it to an existing kind, not adding a branch everywhere.
"""

import os
import zipfile
from dataclasses import dataclass
from io import BytesIO


# ── The closed vocabulary of kinds ───────────────────────────────────────────
KIND_TEXT = "text"                    # source, markdown, config, logs, plain text
KIND_TABULAR = "tabular"              # csv / tsv — text, but read as a table
KIND_NOTEBOOK = "notebook"            # .ipynb
KIND_HTML = "html"                    # html / xhtml — text, but tag-stripped
KIND_IMAGE = "image"                  # vision-capable raster/vector image
KIND_PDF = "pdf"
KIND_DOCUMENT = "document"            # word-processing (docx, doc, odt, rtf)
KIND_SPREADSHEET = "spreadsheet"      # xlsx, xls, ods
KIND_PRESENTATION = "presentation"    # pptx, ppt, odp
KIND_EMAIL = "email"                  # .eml / .msg
KIND_ARCHIVE = "archive"              # zip, tar, gz, 7z, rar
KIND_AUDIO = "audio"
KIND_VIDEO = "video"
KIND_BINARY = "binary"                # known-opaque: executables, fonts, dbs


@dataclass(frozen=True)
class FileType:
    """What a file is, resolved."""
    kind: str
    media_type: str          # canonical MIME, regardless of what the client said
    label: str               # human/model-readable name, e.g. "Word document (.docx)"
    extension: str           # normalized, lowercase, with dot ("" if none)
    declared_type: str = ""  # what the client CLAIMED, kept for audit logging
    detected_by: str = ""    # "magic" | "container" | "extension" | "declared" | "content"

    @property
    def is_vision(self) -> bool:
        """True when the raw bytes can go to a vision model as-is. SVG is an
        image to a browser but XML to a model, so it is excluded here and
        handled as text by the extractor."""
        return self.kind == KIND_IMAGE and self.media_type in _VISION_MEDIA_TYPES

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "media_type": self.media_type,
            "label": self.label,
            "extension": self.extension,
            "detected_by": self.detected_by,
        }


# Media types a vision-capable LLM accepts inline. Anything outside this set
# is NOT sent as an image even if it is one (e.g. .tiff, .heic) — it is
# reported honestly instead, because a provider rejecting the media type fails
# the whole request, not just the attachment.
_VISION_MEDIA_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


# ── 1. Magic byte signatures ─────────────────────────────────────────────────
# (offset, signature, kind, media_type, label). Order matters only where one
# signature prefixes another; ZIP and OLE deliberately resolve to a placeholder
# that the container probe then refines.
_SIGNATURES = [
    (0, b"\x89PNG\r\n\x1a\n", KIND_IMAGE, "image/png", "PNG image"),
    (0, b"\xff\xd8\xff", KIND_IMAGE, "image/jpeg", "JPEG image"),
    (0, b"GIF87a", KIND_IMAGE, "image/gif", "GIF image"),
    (0, b"GIF89a", KIND_IMAGE, "image/gif", "GIF image"),
    (0, b"BM", KIND_IMAGE, "image/bmp", "BMP image"),
    (0, b"II*\x00", KIND_IMAGE, "image/tiff", "TIFF image"),
    (0, b"MM\x00*", KIND_IMAGE, "image/tiff", "TIFF image"),
    (0, b"%PDF-", KIND_PDF, "application/pdf", "PDF document"),
    (0, b"{\\rtf", KIND_DOCUMENT, "application/rtf", "RTF document"),
    (0, b"OggS", KIND_AUDIO, "audio/ogg", "Ogg audio"),
    (0, b"fLaC", KIND_AUDIO, "audio/flac", "FLAC audio"),
    (0, b"ID3", KIND_AUDIO, "audio/mpeg", "MP3 audio"),
    (0, b"\xff\xfb", KIND_AUDIO, "audio/mpeg", "MP3 audio"),
    (0, b"\x1aE\xdf\xa3", KIND_VIDEO, "video/x-matroska", "Matroska video (.mkv/.webm)"),
    (0, b"FLV\x01", KIND_VIDEO, "video/x-flv", "Flash video"),
    (0, b"7z\xbc\xaf\x27\x1c", KIND_ARCHIVE, "application/x-7z-compressed", "7-Zip archive"),
    (0, b"Rar!\x1a\x07", KIND_ARCHIVE, "application/vnd.rar", "RAR archive"),
    (0, b"\x1f\x8b", KIND_ARCHIVE, "application/gzip", "gzip archive"),
    (0, b"BZh", KIND_ARCHIVE, "application/x-bzip2", "bzip2 archive"),
    (0, b"\xfd7zXZ\x00", KIND_ARCHIVE, "application/x-xz", "xz archive"),
    (257, b"ustar", KIND_ARCHIVE, "application/x-tar", "tar archive"),
    (0, b"SQLite format 3\x00", KIND_BINARY, "application/vnd.sqlite3", "SQLite database"),
    (0, b"MZ", KIND_BINARY, "application/x-msdownload", "Windows executable"),
    (0, b"\x7fELF", KIND_BINARY, "application/x-elf", "ELF executable"),
    (0, b"\xca\xfe\xba\xbe", KIND_BINARY, "application/java-vm", "Java class file"),
    (0, b"wOFF", KIND_BINARY, "font/woff", "WOFF font"),
    (0, b"wOF2", KIND_BINARY, "font/woff2", "WOFF2 font"),
    (0, b"\x00\x01\x00\x00\x00", KIND_BINARY, "font/ttf", "TrueType font"),
]

# ZIP and OLE2 need the container probe to say what they really are, so their
# signatures are handled separately rather than in the table above.
_ZIP_MAGIC = b"PK\x03\x04"
_ZIP_EMPTY = b"PK\x05\x06"          # a valid, empty archive
_ZIP_SPANNED = b"PK\x07\x08"
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


# ── 2. ZIP container members → real format ───────────────────────────────────
# Each OOXML/ODF format is identified by a member path unique to it.
_ZIP_MEMBER_SIGNATURES = [
    ("word/document.xml", KIND_DOCUMENT,
     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     "Word document (.docx)", ".docx"),
    ("xl/workbook.xml", KIND_SPREADSHEET,
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
     "Excel workbook (.xlsx)", ".xlsx"),
    ("ppt/presentation.xml", KIND_PRESENTATION,
     "application/vnd.openxmlformats-officedocument.presentationml.presentation",
     "PowerPoint presentation (.pptx)", ".pptx"),
]

# ODF declares its type in a plain-text `mimetype` member, so it is read
# rather than pattern-matched.
_ODF_TYPES = {
    "application/vnd.oasis.opendocument.text":
        (KIND_DOCUMENT, "OpenDocument text (.odt)", ".odt"),
    "application/vnd.oasis.opendocument.spreadsheet":
        (KIND_SPREADSHEET, "OpenDocument spreadsheet (.ods)", ".ods"),
    "application/vnd.oasis.opendocument.presentation":
        (KIND_PRESENTATION, "OpenDocument presentation (.odp)", ".odp"),
}


# ── 3. Extension map ─────────────────────────────────────────────────────────
# Only formats that magic bytes cannot settle. Text formats dominate because
# almost none of them have a header.
_EXTENSION_MAP = {
    # tabular
    ".csv": (KIND_TABULAR, "text/csv", "CSV data"),
    ".tsv": (KIND_TABULAR, "text/tab-separated-values", "TSV data"),
    ".psv": (KIND_TABULAR, "text/plain", "Pipe-separated data"),
    # structured text the model reads as-is
    ".json": (KIND_TEXT, "application/json", "JSON"),
    ".jsonl": (KIND_TEXT, "application/x-ndjson", "JSON Lines"),
    ".ndjson": (KIND_TEXT, "application/x-ndjson", "JSON Lines"),
    ".yaml": (KIND_TEXT, "application/yaml", "YAML"),
    ".yml": (KIND_TEXT, "application/yaml", "YAML"),
    ".toml": (KIND_TEXT, "application/toml", "TOML"),
    ".xml": (KIND_TEXT, "application/xml", "XML"),
    ".svg": (KIND_TEXT, "image/svg+xml", "SVG image (XML source)"),
    ".md": (KIND_TEXT, "text/markdown", "Markdown"),
    ".markdown": (KIND_TEXT, "text/markdown", "Markdown"),
    ".rst": (KIND_TEXT, "text/x-rst", "reStructuredText"),
    ".txt": (KIND_TEXT, "text/plain", "Plain text"),
    ".log": (KIND_TEXT, "text/plain", "Log file"),
    ".env": (KIND_TEXT, "text/plain", "Environment file"),
    ".ini": (KIND_TEXT, "text/plain", "INI config"),
    ".cfg": (KIND_TEXT, "text/plain", "Config file"),
    ".conf": (KIND_TEXT, "text/plain", "Config file"),
    ".properties": (KIND_TEXT, "text/plain", "Java properties"),
    ".sql": (KIND_TEXT, "application/sql", "SQL script"),
    ".graphql": (KIND_TEXT, "application/graphql", "GraphQL schema"),
    ".proto": (KIND_TEXT, "text/plain", "Protocol Buffers schema"),
    ".patch": (KIND_TEXT, "text/x-diff", "Patch/diff"),
    ".diff": (KIND_TEXT, "text/x-diff", "Patch/diff"),
    # markup read as text after tag-stripping
    ".html": (KIND_HTML, "text/html", "HTML"),
    ".htm": (KIND_HTML, "text/html", "HTML"),
    ".xhtml": (KIND_HTML, "application/xhtml+xml", "XHTML"),
    # notebooks
    ".ipynb": (KIND_NOTEBOOK, "application/x-ipynb+json", "Jupyter notebook"),
    # mail
    ".eml": (KIND_EMAIL, "message/rfc822", "Email message (.eml)"),
    ".msg": (KIND_EMAIL, "application/vnd.ms-outlook", "Outlook message (.msg)"),
    # media containers whose magic is offset-dependent (ftyp at byte 4)
    ".mp4": (KIND_VIDEO, "video/mp4", "MP4 video"),
    ".m4v": (KIND_VIDEO, "video/x-m4v", "MPEG-4 video"),
    ".mov": (KIND_VIDEO, "video/quicktime", "QuickTime video"),
    ".avi": (KIND_VIDEO, "video/x-msvideo", "AVI video"),
    ".wmv": (KIND_VIDEO, "video/x-ms-wmv", "WMV video"),
    ".webm": (KIND_VIDEO, "video/webm", "WebM video"),
    ".mkv": (KIND_VIDEO, "video/x-matroska", "Matroska video"),
    ".mpg": (KIND_VIDEO, "video/mpeg", "MPEG video"),
    ".mpeg": (KIND_VIDEO, "video/mpeg", "MPEG video"),
    ".mp3": (KIND_AUDIO, "audio/mpeg", "MP3 audio"),
    ".wav": (KIND_AUDIO, "audio/wav", "WAV audio"),
    ".m4a": (KIND_AUDIO, "audio/mp4", "M4A audio"),
    ".aac": (KIND_AUDIO, "audio/aac", "AAC audio"),
    ".ogg": (KIND_AUDIO, "audio/ogg", "Ogg audio"),
    ".opus": (KIND_AUDIO, "audio/opus", "Opus audio"),
    ".flac": (KIND_AUDIO, "audio/flac", "FLAC audio"),
    # images without a distinctive header we check
    ".webp": (KIND_IMAGE, "image/webp", "WebP image"),
    ".heic": (KIND_IMAGE, "image/heic", "HEIC image"),
    ".ico": (KIND_IMAGE, "image/x-icon", "Icon"),
    # legacy office (OLE2) — the container probe usually gets these, this is
    # the fallback when the header is unreadable
    ".doc": (KIND_DOCUMENT, "application/msword", "Word 97-2003 document (.doc)"),
    ".xls": (KIND_SPREADSHEET, "application/vnd.ms-excel", "Excel 97-2003 workbook (.xls)"),
    ".ppt": (KIND_PRESENTATION, "application/vnd.ms-powerpoint",
             "PowerPoint 97-2003 presentation (.ppt)"),
    ".rtf": (KIND_DOCUMENT, "application/rtf", "RTF document"),
    # archives
    ".zip": (KIND_ARCHIVE, "application/zip", "ZIP archive"),
    ".tar": (KIND_ARCHIVE, "application/x-tar", "tar archive"),
    ".gz": (KIND_ARCHIVE, "application/gzip", "gzip archive"),
    ".tgz": (KIND_ARCHIVE, "application/gzip", "gzip archive"),
    ".7z": (KIND_ARCHIVE, "application/x-7z-compressed", "7-Zip archive"),
    ".rar": (KIND_ARCHIVE, "application/vnd.rar", "RAR archive"),
    ".jar": (KIND_ARCHIVE, "application/java-archive", "Java archive"),
    # opaque
    ".exe": (KIND_BINARY, "application/x-msdownload", "Windows executable"),
    ".dll": (KIND_BINARY, "application/x-msdownload", "Windows library"),
    ".so": (KIND_BINARY, "application/x-sharedlib", "Shared library"),
    ".dylib": (KIND_BINARY, "application/x-sharedlib", "Shared library"),
    ".pyc": (KIND_BINARY, "application/x-python-code", "Compiled Python"),
    ".class": (KIND_BINARY, "application/java-vm", "Java class file"),
    ".db": (KIND_BINARY, "application/octet-stream", "Database file"),
    ".sqlite": (KIND_BINARY, "application/vnd.sqlite3", "SQLite database"),
    ".ttf": (KIND_BINARY, "font/ttf", "TrueType font"),
    ".otf": (KIND_BINARY, "font/otf", "OpenType font"),
    ".woff": (KIND_BINARY, "font/woff", "WOFF font"),
    ".woff2": (KIND_BINARY, "font/woff2", "WOFF2 font"),
}

# Source-code extensions all resolve to the same (text, text/plain) pair, so
# they are listed rather than repeated. An extension NOT in any list still
# reaches the content heuristic and is read as text if it decodes cleanly —
# which is why an unfamiliar language works without a code change here.
_CODE_EXTENSIONS = {
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java",
    ".kt", ".kts", ".scala", ".go", ".rs", ".rb", ".php", ".cs", ".fs",
    ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm", ".swift",
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
    ".pl", ".pm", ".r", ".jl", ".lua", ".dart", ".ex", ".exs", ".erl",
    ".hs", ".clj", ".cljs", ".vue", ".svelte", ".astro",
    ".css", ".scss", ".sass", ".less", ".styl",
    ".tf", ".tfvars", ".hcl", ".bicep", ".gradle", ".cmake", ".mk",
    ".vb", ".vbs", ".asm", ".s", ".cob", ".cbl", ".pas", ".f", ".f90",
}

# Extension-less filenames that are unambiguously text.
_KNOWN_TEXT_FILENAMES = {
    "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "vagrantfile",
    "jenkinsfile", "brewfile", "caddyfile", "license", "notice", "readme",
    "changelog", "authors", "contributors", "codeowners", ".gitignore",
    ".dockerignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc",
}


def _match_signature(head: bytes):
    """First magic-byte hit, or None."""
    for offset, sig, kind, media, label in _SIGNATURES:
        if len(head) >= offset + len(sig) and head[offset:offset + len(sig)] == sig:
            return kind, media, label
    return None


def _probe_zip(source):
    """Look inside a ZIP to tell .docx/.xlsx/.pptx/.odt from a plain archive.

    `source` is either the full bytes or a filesystem path. A path is what
    detect_path() passes, and it matters: a ZIP's member list lives in the
    central directory at the END of the file, so probing a truncated head
    would misreport every .docx over the read window as a plain archive.

    Returns (kind, media_type, label, canonical_ext) or None when it is just an
    archive. Never raises: a truncated or corrupt ZIP is reported as an archive,
    which is the honest answer — we could not see inside it.
    """
    try:
        with zipfile.ZipFile(BytesIO(source) if isinstance(source, bytes) else source) as zf:
            names = set(zf.namelist())

            for member, kind, media, label, ext in _ZIP_MEMBER_SIGNATURES:
                if member in names:
                    return kind, media, label, ext

            # ODF stores its declared type as the first member, uncompressed.
            if "mimetype" in names:
                declared = zf.read("mimetype").decode("ascii", "ignore").strip()
                if declared in _ODF_TYPES:
                    kind, label, ext = _ODF_TYPES[declared]
                    return kind, declared, label, ext
    except (zipfile.BadZipFile, OSError, KeyError, ValueError):
        return None
    return None


def _probe_ole(data: bytes, extension: str):
    """Legacy Office (OLE2 compound file). .doc/.xls/.ppt share one header, so
    the stream names inside the (uncompressed) container are what distinguish
    them — searched as raw UTF-16LE, which avoids a full OLE parser for a
    question this crude check answers reliably."""
    head = data[:16384]
    if b"W\x00o\x00r\x00d\x00D\x00o\x00c\x00u\x00m\x00e\x00n\x00t" in head:
        return (KIND_DOCUMENT, "application/msword",
                "Word 97-2003 document (.doc)", ".doc")
    if b"W\x00o\x00r\x00k\x00b\x00o\x00o\x00k" in head or b"B\x00o\x00o\x00k" in head:
        return (KIND_SPREADSHEET, "application/vnd.ms-excel",
                "Excel 97-2003 workbook (.xls)", ".xls")
    if b"P\x00o\x00w\x00e\x00r\x00P\x00o\x00i\x00n\x00t" in head:
        return (KIND_PRESENTATION, "application/vnd.ms-powerpoint",
                "PowerPoint 97-2003 presentation (.ppt)", ".ppt")
    # Header says OLE2 but no stream matched — fall back to the extension,
    # then to a generic legacy-office label.
    mapped = _EXTENSION_MAP.get(extension)
    if mapped:
        return mapped[0], mapped[1], mapped[2], extension
    return (KIND_BINARY, "application/x-ole-storage",
            "Legacy Office / OLE2 compound file", extension)


def _probe_iso_media(head: bytes):
    """MP4-family containers put `ftyp` at byte 4 and a brand right after it.
    The brand is what separates video/mp4 from audio/mp4 (an .m4a) and from
    image/heic — all three are the same container."""
    if len(head) < 12 or head[4:8] != b"ftyp":
        return None
    brand = head[8:12]
    if brand in (b"M4A ", b"M4B "):
        return KIND_AUDIO, "audio/mp4", "M4A audio"
    if brand in (b"heic", b"heix", b"hevc", b"mif1"):
        return KIND_IMAGE, "image/heic", "HEIC image"
    if brand == b"qt  ":
        return KIND_VIDEO, "video/quicktime", "QuickTime video"
    return KIND_VIDEO, "video/mp4", "MP4 video"


def _probe_riff(head: bytes):
    """RIFF containers hold WAV, AVI and WebP — the format tag at byte 8 says
    which."""
    if len(head) < 12 or head[:4] != b"RIFF":
        return None
    fmt = head[8:12]
    if fmt == b"WAVE":
        return KIND_AUDIO, "audio/wav", "WAV audio"
    if fmt == b"AVI ":
        return KIND_VIDEO, "video/x-msvideo", "AVI video"
    if fmt == b"WEBP":
        return KIND_IMAGE, "image/webp", "WebP image"
    return None


def looks_like_text(data: bytes) -> bool:
    """Last-resort text detection, same shape as git's: a NUL byte in the first
    8 KB means binary, otherwise it is text if it decodes as UTF-8 (or as
    UTF-16 with a BOM). Deliberately conservative — misclassifying a binary as
    text dumps mojibake into the model's context."""
    if not data:
        return True  # an empty file is a readable (empty) text file
    head = data[:8192]
    if b"\x00" in head:
        # UTF-16 text is full of NULs and starts with a BOM; everything else
        # with a NUL is binary.
        return head[:2] in (b"\xff\xfe", b"\xfe\xff")
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError:
        # A multi-byte character straddling the 8 KB cut is not a failure.
        try:
            head[:-4].decode("utf-8")
            return True
        except UnicodeDecodeError:
            return False


def detect(data: bytes, filename: str = "", declared_type: str = "",
           zip_source=None) -> FileType:
    """Resolve `data` to a FileType. Never raises, always returns something.

    `zip_source` overrides what the ZIP container probe reads — detect_path()
    passes the path so the probe sees the whole archive rather than the header
    slice it was handed for signature matching.
    """
    name = os.path.basename(filename or "")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    declared = (declared_type or "").split(";")[0].strip().lower()
    head = data[:1024] if data else b""

    # 1. Container probes that need more than a fixed prefix.
    for probe in (_probe_iso_media, _probe_riff):
        hit = probe(head)
        if hit:
            kind, media, label = hit
            return FileType(kind, media, label, ext, declared, "magic")

    # 2. ZIP / OLE — magic identifies the container, members identify the format.
    if head[:4] in (_ZIP_MAGIC, _ZIP_EMPTY, _ZIP_SPANNED):
        probed = _probe_zip(zip_source if zip_source is not None else data)
        if probed:
            kind, media, label, canonical_ext = probed
            return FileType(kind, media, label, canonical_ext or ext,
                            declared, "container")
        return FileType(KIND_ARCHIVE, "application/zip", "ZIP archive",
                        ext or ".zip", declared, "magic")

    if head[:8] == _OLE_MAGIC:
        kind, media, label, canonical_ext = _probe_ole(data, ext)
        return FileType(kind, media, label, canonical_ext or ext,
                        declared, "container")

    # 3. Fixed-prefix magic bytes.
    hit = _match_signature(head)
    if hit:
        kind, media, label = hit
        # A .ipynb is JSON with no magic of its own, but a plain .json holding
        # notebook keys should still read as a notebook — handled at 4.
        return FileType(kind, media, label, ext, declared, "magic")

    # 4. Extension.
    if ext in _EXTENSION_MAP:
        kind, media, label = _EXTENSION_MAP[ext]
        return FileType(kind, media, label, ext, declared, "extension")
    if ext in _CODE_EXTENSIONS:
        lang = ext.lstrip(".")
        return FileType(KIND_TEXT, "text/plain", f"{lang} source file",
                        ext, declared, "extension")
    if not ext and name.lower() in _KNOWN_TEXT_FILENAMES:
        return FileType(KIND_TEXT, "text/plain", f"{name} (text)",
                        "", declared, "extension")

    # 5. The client's claim — trusted only for text-ish types it cannot use to
    #    smuggle bytes anywhere dangerous. An `image/*` claim is deliberately
    #    NOT honoured here: reaching this point means the bytes have no image
    #    signature, so the claim is either wrong or hostile.
    if declared.startswith("text/") or declared in (
        "application/json", "application/xml", "application/yaml",
        "application/x-yaml", "application/javascript", "application/sql",
    ):
        if looks_like_text(data):
            return FileType(KIND_TEXT, declared or "text/plain",
                            "Text file", ext, declared, "declared")

    # 6. Content heuristic.
    if looks_like_text(data):
        return FileType(KIND_TEXT, "text/plain",
                        f"Text file{f' ({ext})' if ext else ''}",
                        ext, declared, "content")

    return FileType(KIND_BINARY, declared or "application/octet-stream",
                    f"Unrecognised binary{f' ({ext})' if ext else ''}",
                    ext, declared, "content")


def detect_path(path: str, declared_type: str = "") -> FileType:
    """detect() for a file on disk. Reads only the header — a 2 GB video is
    identified from 64 KB — and hands the ZIP probe the path so it can still
    seek to the central directory."""
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
    except OSError:
        head = b""
    return detect(head, filename=path, declared_type=declared_type,
                  zip_source=path)
