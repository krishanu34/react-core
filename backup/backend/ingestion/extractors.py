"""
Extractors — bytes in, model-legible content out.

One function per detect.KIND_*, dispatched by `extract()`. Every extractor
obeys the same three rules:

  1. NEVER return garbage. If a format cannot be parsed, return an empty text
     with a note saying why and what would fix it. The old PDF path in
     tools/read_file_tool.py regex-scraped `\\((.*?)\\)` out of raw PDF bytes,
     which on any real (Flate-compressed) PDF yields noise the model then
     reasons over as if it were the document. Nothing is strictly worse than
     confident nonsense — an explicit "no text layer" is better.
  2. NEVER raise. A malformed upload is a normal event, not a server error;
     a parser blowing up must cost the user a note, not their turn.
  3. DEGRADE, don't disappear. Where a third-party parser is the better tool
     but may not be installed, there is a stdlib fallback (OOXML formats are
     ZIP + XML, which zipfile and ElementTree handle unaided). The optional
     library raises quality; its absence never removes the capability.

Optional libraries, best first, all import-guarded:
    PDF          pdfplumber → PyMuPDF (fitz) → pypdf
    .docx        python-docx → stdlib zip/XML
    .xlsx        openpyxl    → stdlib zip/XML
    .pptx        python-pptx → stdlib zip/XML
    images       Pillow (dimensions + format conversion) → header parsing
"""

import io
import os
import re
import struct
import zipfile
from typing import Optional
from xml.etree import ElementTree

from . import limits
from .content import ExtractedContent, ImageBlock, decode_text
from .detect import (
    KIND_ARCHIVE, KIND_AUDIO, KIND_BINARY, KIND_DOCUMENT, KIND_EMAIL,
    KIND_HTML, KIND_IMAGE, KIND_NOTEBOOK, KIND_PDF, KIND_PRESENTATION,
    KIND_SPREADSHEET, KIND_TABULAR, KIND_TEXT, KIND_VIDEO,
    FileType, detect, detect_path,
)

try:
    from utils.logger import get_logger
    log = get_logger(__name__)
except Exception:  # noqa: BLE001 — ingestion is importable outside the app
    import logging
    log = logging.getLogger(__name__)


# ── Entry points ─────────────────────────────────────────────────────────────

def extract(data: bytes, filename: str = "", declared_type: str = "",
            file_type: FileType = None) -> ExtractedContent:
    """Make `data` legible to a model. Never raises."""
    ft = file_type or detect(data, filename, declared_type)
    handler = _HANDLERS.get(ft.kind, _extract_binary)
    try:
        result = handler(data, ft, filename)
    except Exception as e:  # noqa: BLE001 — rule 2
        log.warning("Extraction failed for %s (%s): %s", filename, ft.kind, e)
        result = ExtractedContent(kind=ft.kind, label=ft.label,
                                  media_type=ft.media_type)
        result.note(
            f"This file could not be parsed ({type(e).__name__}). It may be "
            f"corrupt, incomplete, or not really a {ft.label}."
        )
    result.size_bytes = len(data)
    result.metadata.setdefault("detected_by", ft.detected_by)
    return result.finalize()


def extract_file(path: str, declared_type: str = "") -> ExtractedContent:
    """extract() for a file on disk.

    Formats whose useful content is metadata rather than bytes — video, audio,
    archives, opaque binaries — are handled WITHOUT loading the file, so
    reading a 2 GB screen recording costs a stat() and a 64 KB header read
    instead of 2 GB of RAM.
    """
    ft = detect_path(path, declared_type)
    try:
        size = os.path.getsize(path)
    except OSError as e:
        result = ExtractedContent(kind=ft.kind, label=ft.label,
                                  media_type=ft.media_type)
        return result.note(f"File could not be opened: {e}")

    if ft.kind in (KIND_VIDEO, KIND_AUDIO, KIND_ARCHIVE, KIND_BINARY):
        # Media gets head AND tail: an MP4 that was not written for streaming
        # keeps its `moov`/`mvhd` atom at the END of the file, so a head-only
        # read reports every such recording as duration-unknown.
        sample = (_head_and_tail(path, size) if ft.kind in (KIND_VIDEO, KIND_AUDIO)
                  else _head_of(path))
        try:
            result = _HANDLERS[ft.kind](sample, ft, path, size=size, path=path)
        except Exception as e:  # noqa: BLE001
            log.warning("Extraction failed for %s: %s", path, e)
            result = ExtractedContent(kind=ft.kind, label=ft.label,
                                      media_type=ft.media_type)
            result.note(f"Could not inspect this file ({type(e).__name__}).")
        result.size_bytes = size
        return result.finalize()

    # Everything else needs the whole file, but not more than we would ever
    # send onward.
    cap = limits.max_file_bytes()
    if size > cap:
        result = ExtractedContent(kind=ft.kind, label=ft.label,
                                  media_type=ft.media_type, size_bytes=size)
        return result.note(
            f"File is {size:,} bytes, over the {cap:,}-byte processing limit. "
            f"Raise INGEST_MAX_FILE_BYTES, or split the file."
        ).finalize()

    with open(path, "rb") as f:
        data = f.read()
    return extract(data, filename=path, declared_type=declared_type, file_type=ft)


def _head_of(path: str, size: int = 65536) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read(size)
    except OSError:
        return b""


def _head_and_tail(path: str, file_size: int, window: int = 262144) -> bytes:
    """First and last `window` bytes, concatenated.

    Only ever used for header/atom SEARCHES, never for anything that depends on
    absolute file offsets — the two halves are adjacent here but not in the
    file, so a match's position is meaningless. Every field read from a match
    is at a fixed offset relative to that match, which survives the splice.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(window)
            if file_size <= window:
                return head
            f.seek(max(window, file_size - window))
            return head + f.read(window)
    except OSError:
        return b""


# ── Text-shaped formats ──────────────────────────────────────────────────────

def _extract_text(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    text, encoding = decode_text(data)
    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type, text=text,
                           extractor="decode")
    out.metadata["encoding"] = encoding
    out.metadata["lines"] = text.count("\n") + 1 if text else 0
    if encoding not in ("utf-8", "utf-8-sig"):
        out.note(f"Decoded as {encoding} (not UTF-8).")
    return out


def _extract_tabular(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """CSV/TSV: a schema summary plus a bounded row preview.

    A model given 200 000 raw rows learns less than one given the columns,
    the row count, and the first 500 rows — and the raw dump costs the whole
    context window. The summary is what makes "what's in this export?"
    answerable at all.
    """
    import csv

    raw, encoding = decode_text(data)
    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type, extractor="csv")
    out.metadata["encoding"] = encoding
    if not raw.strip():
        return out.note("File is empty.")

    sample = raw[:65536]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        delimiter = dialect.delimiter
    except csv.Error:
        # Sniffer fails on single-column files and on ragged data. Fall back to
        # whichever candidate appears most on the first line — wrong only when
        # the file has no delimiter at all, in which case any choice is fine.
        first = sample.splitlines()[0] if sample.splitlines() else ""
        delimiter = max(",;\t|", key=first.count) if first else ","

    reader = csv.reader(io.StringIO(raw), delimiter=delimiter)
    max_rows, max_cols = limits.max_sheet_rows(), limits.max_sheet_cols()

    rows, total = [], 0
    for i, row in enumerate(reader):
        total += 1
        if i < max_rows:
            rows.append(row[:max_cols])

    if not rows:
        return out.note("No rows could be parsed.")

    header = rows[0]
    out.metadata["rows"] = total
    out.metadata["columns"] = len(header)
    out.metadata["delimiter"] = repr(delimiter)

    lines = [f"Columns ({len(header)}): " + ", ".join(str(c) for c in header)]
    lines.append("")
    for row in rows:
        lines.append(delimiter.join(str(c) for c in row))
    out.text = "\n".join(lines)

    if total > len(rows):
        out.truncated = True
        out.note(f"Showing the first {len(rows):,} of {total:,} rows.")
    if len(header) > max_cols:
        out.note(f"Showing the first {max_cols} columns.")
    return out


def _extract_html(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """HTML → readable text. Script and style bodies are dropped: they are
    never what someone attaching a page wants read, and a bundled JS payload
    inside an .html export can be larger than the whole context window."""
    from html.parser import HTMLParser
    from html import unescape

    raw, encoding = decode_text(data)

    class _Stripper(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts = []
            self.title = ""
            self._skip = 0
            self._in_title = False

        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "noscript", "svg"):
                self._skip += 1
            elif tag == "title":
                self._in_title = True
            elif tag in ("p", "div", "br", "li", "tr", "section", "article",
                         "h1", "h2", "h3", "h4", "h5", "h6"):
                self.parts.append("\n")

        def handle_endtag(self, tag):
            if tag in ("script", "style", "noscript", "svg"):
                self._skip = max(0, self._skip - 1)
            elif tag == "title":
                self._in_title = False

        def handle_data(self, text):
            if self._skip:
                return
            if self._in_title:
                self.title += text.strip()
            elif text.strip():
                self.parts.append(text)

    parser = _Stripper()
    parser.feed(raw)
    text = re.sub(r"\n{3,}", "\n\n", unescape("".join(parser.parts))).strip()

    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type, text=text,
                           extractor="html.parser")
    out.metadata["encoding"] = encoding
    if parser.title:
        out.metadata["title"] = parser.title
    out.note("HTML tags, scripts and styles were stripped; only visible text is shown.")
    return out


def _extract_notebook(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """Jupyter notebook → cells with their outputs, the way Claude Code's Read
    presents them. Outputs matter: a traceback in cell 12 is usually the whole
    reason the notebook was attached."""
    import json

    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type, extractor="ipynb")
    raw, _ = decode_text(data)
    try:
        nb = json.loads(raw)
    except ValueError as e:
        return out.note(f"Not valid notebook JSON: {e}")

    cells = nb.get("cells", [])
    cap = limits.max_notebook_cells()
    out.metadata["cells"] = len(cells)
    out.metadata["kernel"] = (
        nb.get("metadata", {}).get("kernelspec", {}).get("display_name", "unknown")
    )

    parts = []
    for i, cell in enumerate(cells[:cap]):
        source = "".join(cell.get("source", []))
        parts.append(f"--- Cell {i} [{cell.get('cell_type', 'unknown')}] ---\n{source}")
        for output in cell.get("outputs", [])[:3]:
            chunk = ""
            if "text" in output:
                chunk = "".join(output["text"])
            elif "traceback" in output:
                chunk = "\n".join(output["traceback"])
            elif "data" in output:
                chunk = "".join(output["data"].get("text/plain", []))
            if chunk.strip():
                parts.append(f"  Output: {chunk[:1000]}")

    out.text = "\n\n".join(parts)
    if len(cells) > cap:
        out.truncated = True
        out.note(f"Showing the first {cap} of {len(cells)} cells.")
    return out


def _extract_email(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """.eml via the stdlib email parser. .msg is Outlook's OLE format and needs
    a third-party parser, so it is reported rather than guessed at."""
    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type, extractor="email")

    if ft.extension == ".msg":
        return out.note(
            "Outlook .msg is a proprietary binary format. Re-save the message "
            "as .eml, or install extract-msg on the server, to read its body."
        )

    from email import policy
    from email.parser import BytesParser

    msg = BytesParser(policy=policy.default).parsebytes(data)
    headers = [f"{h}: {msg.get(h)}" for h in ("From", "To", "Cc", "Subject", "Date")
               if msg.get(h)]

    body_part = msg.get_body(preferencelist=("plain", "html"))
    body = ""
    if body_part is not None:
        body = body_part.get_content()
        if body_part.get_content_type() == "text/html":
            body = _extract_html(body.encode("utf-8", "replace"), ft, filename).text

    attachments = [
        f"{p.get_filename() or 'unnamed'} ({p.get_content_type()})"
        for p in msg.iter_attachments()
    ]
    if attachments:
        out.metadata["attachments"] = len(attachments)

    out.text = "\n".join(headers + ([""] if headers else []) + [body])
    if attachments:
        out.text += "\n\nAttachments: " + ", ".join(attachments)
        out.note("The email's own attachments were NOT extracted — attach them "
                 "directly if their contents matter.")
    return out


# ── PDF ──────────────────────────────────────────────────────────────────────

def _extract_pdf(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """Text per page, and — when there is no text layer — rendered pages.

    "No text layer" is the case that matters: a scanned or exported-from-Figma
    PDF has zero extractable characters, and every text-only pipeline reports
    it as an empty document. Rendering the first few pages to images and
    handing them to a vision model is the only way that file becomes readable
    at all, and it is what makes a scanned requirements doc usable here.
    """
    out = ExtractedContent(kind=ft.kind, label=ft.label,
                           media_type=ft.media_type)
    pages, backend, total_pages = _pdf_text(data)

    if backend is None:
        return out.note(
            "No PDF text extractor is installed on the server. Install one of "
            "pdfplumber, PyMuPDF or pypdf (`pip install pdfplumber`) to read "
            "PDF attachments."
        )

    out.extractor = backend
    out.metadata["pages"] = total_pages
    max_pages = limits.max_pdf_pages()

    body = "\n\n".join(
        f"--- Page {i + 1} ---\n{text}" for i, text in enumerate(pages) if text.strip()
    )
    out.text = body

    if total_pages > max_pages:
        out.truncated = True
        out.note(f"Read the first {max_pages} of {total_pages} pages.")

    if not body.strip():
        out.note(
            f"This PDF has no text layer — it is a scan or an image export, so "
            f"there is nothing to extract as text."
        )
        rendered = _render_pdf_pages(data, filename)
        if rendered:
            out.images = rendered
            out.note(
                f"Rendered the first {len(rendered)} page(s) to images so they "
                f"can be read visually."
            )
        else:
            out.note(
                "Page rendering is unavailable (install PyMuPDF: "
                "`pip install pymupdf`), so this document cannot be read at "
                "all in its current form. Ask the user for a text-based "
                "version, or run OCR on it."
            )
    return out


def _pdf_text(data: bytes) -> tuple:
    """(page_texts, backend_name, total_pages). Backends in quality order."""
    max_pages = limits.max_pdf_pages()

    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            total = len(pdf.pages)
            texts = [(p.extract_text() or "") for p in pdf.pages[:max_pages]]
        return texts, "pdfplumber", total
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 — try the next backend
        log.debug("pdfplumber failed, trying PyMuPDF: %s", e)

    try:
        import fitz
        with fitz.open(stream=data, filetype="pdf") as doc:
            total = doc.page_count
            texts = [doc.load_page(i).get_text() for i in range(min(total, max_pages))]
        return texts, "pymupdf", total
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        log.debug("PyMuPDF failed, trying pypdf: %s", e)

    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        total = len(reader.pages)
        texts = [(p.extract_text() or "") for p in reader.pages[:max_pages]]
        return texts, "pypdf", total
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        log.debug("pypdf failed: %s", e)

    return [], None, 0


def _render_pdf_pages(data: bytes, filename: str) -> list:
    """Rasterise the first N pages for vision. PyMuPDF only — it is the one
    backend here that renders rather than merely parses."""
    try:
        import fitz
    except ImportError:
        return []

    blocks = []
    try:
        with fitz.open(stream=data, filetype="pdf") as doc:
            for i in range(min(doc.page_count, limits.max_pdf_render_pages())):
                # 144 DPI (2x the 72 DPI PDF unit): readable body text without
                # producing a multi-megabyte PNG per page.
                pix = doc.load_page(i).get_pixmap(dpi=144)
                png = pix.tobytes("png")
                if len(png) > limits.max_image_bytes():
                    pix = doc.load_page(i).get_pixmap(dpi=96)
                    png = pix.tobytes("png")
                    if len(png) > limits.max_image_bytes():
                        continue
                blocks.append(ImageBlock.from_bytes(
                    png, "image/png",
                    source=f"page {i + 1} of {os.path.basename(filename) or 'document.pdf'}",
                    width=pix.width, height=pix.height,
                ))
    except Exception as e:  # noqa: BLE001
        log.debug("PDF page rendering failed: %s", e)
    return blocks


# ── OOXML / OpenDocument ─────────────────────────────────────────────────────

# OOXML namespaces. Matching on the local tag name instead would be shorter but
# also wrong — `t` appears in several namespaces within one document.
_NS_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_NS_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_ODF_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"


def _extract_document(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type)

    # RTF is checked by magic first, not by extension: .doc files saved by
    # "Word → Rich Text" are RTF inside, and they are readable — routing them
    # to the legacy-.doc message below would refuse a file we can actually read.
    if data[:5] == b"{\\rtf":
        return _rtf_text(data, out)
    if ft.extension == ".docx":
        return _docx_text(data, out)
    if ft.extension == ".odt":
        return _odf_text(data, out, "content.xml")
    if ft.extension == ".doc":
        return out.note(
            "Word 97-2003 (.doc) is a legacy binary format with no reliable "
            "open parser. Re-save it as .docx or PDF and attach that — both "
            "are read fully here."
        )
    return out.note(f"No extractor for {ft.label}.")


def _docx_text(data: bytes, out: ExtractedContent) -> ExtractedContent:
    """python-docx when present (keeps tables and heading structure), stdlib
    ZIP+XML otherwise."""
    try:
        import docx  # python-docx

        document = docx.Document(io.BytesIO(data))
        parts = []
        for para in document.paragraphs:
            if not para.text.strip():
                continue
            style = (para.style.name or "") if para.style else ""
            # Headings carry the document's structure, and a model that can see
            # it can answer "what does section 4 say" instead of scanning prose.
            if style.startswith("Heading"):
                level = "".join(c for c in style if c.isdigit()) or "1"
                parts.append(f"{'#' * min(int(level), 6)} {para.text.strip()}")
            else:
                parts.append(para.text.strip())

        for t_index, table in enumerate(document.tables):
            rows = []
            for row in table.rows[:limits.max_sheet_rows()]:
                rows.append(" | ".join(c.text.strip().replace("\n", " ")
                                       for c in row.cells[:limits.max_sheet_cols()]))
            if rows:
                parts.append(f"\n[Table {t_index + 1}]\n" + "\n".join(rows))

        out.text = "\n\n".join(parts)
        out.extractor = "python-docx"
        out.metadata["paragraphs"] = len(document.paragraphs)
        out.metadata["tables"] = len(document.tables)
        return out
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 — fall through to the stdlib path
        log.debug("python-docx failed, using stdlib XML: %s", e)

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ElementTree.fromstring(xml)

    paragraphs = []
    for para in root.iter(f"{_NS_W}p"):
        # A paragraph's text is split across runs (one per formatting change),
        # so the runs are joined; w:tab and w:br are the only whitespace
        # elements that carry meaning.
        pieces = []
        for node in para.iter():
            if node.tag == f"{_NS_W}t" and node.text:
                pieces.append(node.text)
            elif node.tag == f"{_NS_W}tab":
                pieces.append("\t")
            elif node.tag == f"{_NS_W}br":
                pieces.append("\n")
        line = "".join(pieces).strip()
        if line:
            paragraphs.append(line)

    out.text = "\n\n".join(paragraphs)
    out.extractor = "zip+xml"
    out.metadata["paragraphs"] = len(paragraphs)
    out.note("Read without python-docx — table layout and heading levels are "
             "flattened. Install python-docx for full structure.")
    return out


def _odf_text(data: bytes, out: ExtractedContent, member: str) -> ExtractedContent:
    """OpenDocument formats are ZIP + one content.xml; the text lives in
    `text:p` / `text:h` elements regardless of which ODF flavour it is."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        root = ElementTree.fromstring(zf.read(member))
    lines = []
    for tag in ("p", "h"):
        for node in root.iter(f"{_NS_ODF_TEXT}{tag}"):
            text = "".join(node.itertext()).strip()
            if text:
                lines.append(text)
    out.text = "\n\n".join(lines)
    out.extractor = "zip+xml (odf)"
    return out


def _rtf_text(data: bytes, out: ExtractedContent) -> ExtractedContent:
    """Strip RTF control words. RTF is a text format wrapped in escapes, so a
    small stripper genuinely reads it — unlike the PDF case, this is not a
    heuristic that produces plausible noise."""
    raw, _ = decode_text(data)
    # Drop binary/embedded-object groups wholesale, then control words, then
    # convert \'xx hex escapes, then unbalanced braces.
    text = re.sub(r"\{\\\*?\\(?:pict|object|fonttbl|colortbl|stylesheet|info)[^{}]*"
                  r"(?:\{[^{}]*\}[^{}]*)*\}", "", raw)
    text = re.sub(r"\\'([0-9a-fA-F]{2})",
                  lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", "replace"),
                  text)
    text = re.sub(r"\\par[d]?\b", "\n", text)
    text = re.sub(r"\\tab\b", "\t", text)
    text = re.sub(r"\\[a-zA-Z]+-?\d*\s?", "", text)
    text = text.replace("{", "").replace("}", "")
    out.text = re.sub(r"\n{3,}", "\n\n", text).strip()
    out.extractor = "rtf-strip"
    return out


def _extract_spreadsheet(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type)

    if ft.extension == ".xlsx":
        return _xlsx_text(data, out)
    if ft.extension == ".ods":
        return _odf_text(data, out, "content.xml")
    return out.note(
        "Excel 97-2003 (.xls) is a legacy binary format. Re-save it as .xlsx "
        "or export the sheets as CSV and attach that."
    )


def _xlsx_text(data: bytes, out: ExtractedContent) -> ExtractedContent:
    """Each sheet becomes a delimited block. openpyxl when present; otherwise
    the ZIP is read directly, which is enough for the values (formulas and
    formatting are not what an attached workbook is being asked about)."""
    max_rows, max_cols = limits.max_sheet_rows(), limits.max_sheet_cols()
    try:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        blocks = []
        for name in wb.sheetnames[:limits.max_sheets()]:
            ws = wb[name]
            rows = []
            for r, row in enumerate(ws.iter_rows(values_only=True)):
                if r >= max_rows:
                    break
                rows.append(",".join(
                    "" if v is None else str(v) for v in row[:max_cols]
                ))
            blocks.append(f"--- Sheet: {name} ({ws.max_row or 0} rows × "
                          f"{ws.max_column or 0} cols) ---\n" + "\n".join(rows))
        # Read the sheet count BEFORE close(): a read-only workbook drops its
        # archive handle on close and sheetnames is no longer reachable.
        out.metadata["sheets"] = len(wb.sheetnames)
        wb.close()
        out.text = "\n\n".join(blocks)
        out.extractor = "openpyxl"
        return out
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        log.debug("openpyxl failed, using stdlib XML: %s", e)

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()

        # Most cell values are indices into a single shared-strings table.
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ElementTree.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.iter(f"{_NS_S}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{_NS_S}t")))

        # Sheet display names live in workbook.xml; the files are sheetN.xml in
        # the same order, so zipping the two recovers real sheet names.
        sheet_names = []
        if "xl/workbook.xml" in names:
            wb_root = ElementTree.fromstring(zf.read("xl/workbook.xml"))
            sheet_names = [s.get("name", "") for s in wb_root.iter(f"{_NS_S}sheet")]

        sheet_files = sorted(n for n in names
                             if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        blocks = []
        for index, sheet_file in enumerate(sheet_files[:limits.max_sheets()]):
            root = ElementTree.fromstring(zf.read(sheet_file))
            rows = []
            for r, row in enumerate(root.iter(f"{_NS_S}row")):
                if r >= max_rows:
                    break
                cells = []
                for cell in list(row)[:max_cols]:
                    value = cell.find(f"{_NS_S}v")
                    text = value.text if value is not None else ""
                    if cell.get("t") == "s" and text and text.isdigit():
                        idx = int(text)
                        text = shared[idx] if idx < len(shared) else ""
                    elif cell.get("t") == "inlineStr":
                        text = "".join(t.text or ""
                                       for t in cell.iter(f"{_NS_S}t"))
                    cells.append(text or "")
                rows.append(",".join(cells))
            title = sheet_names[index] if index < len(sheet_names) else f"Sheet{index + 1}"
            blocks.append(f"--- Sheet: {title} ---\n" + "\n".join(rows))

    out.text = "\n\n".join(blocks)
    out.extractor = "zip+xml"
    out.metadata["sheets"] = len(sheet_files)
    out.note("Read without openpyxl — cached values only, no formulas. "
             "Install openpyxl for full workbook support.")
    return out


def _extract_presentation(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type)

    if ft.extension == ".odp":
        return _odf_text(data, out, "content.xml")
    if ft.extension != ".pptx":
        return out.note(
            "PowerPoint 97-2003 (.ppt) is a legacy binary format. Re-save it "
            "as .pptx or PDF and attach that."
        )

    try:
        from pptx import Presentation

        prs = Presentation(io.BytesIO(data))
        blocks = []
        for i, slide in enumerate(prs.slides):
            if i >= limits.max_slides():
                break
            texts = [shape.text.strip() for shape in slide.shapes
                     if getattr(shape, "has_text_frame", False) and shape.text.strip()]
            notes = ""
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                notes = slide.notes_slide.notes_text_frame.text.strip()
            block = f"--- Slide {i + 1} ---\n" + "\n".join(texts)
            if notes:
                block += f"\n[Speaker notes] {notes}"
            blocks.append(block)
        out.text = "\n\n".join(blocks)
        out.extractor = "python-pptx"
        out.metadata["slides"] = len(prs.slides)
        return out
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        log.debug("python-pptx failed, using stdlib XML: %s", e)

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # slide2.xml sorts before slide10.xml lexically, so slides are ordered
        # by the number in the filename or the deck comes out shuffled.
        slide_files = sorted(
            (n for n in zf.namelist()
             if n.startswith("ppt/slides/slide") and n.endswith(".xml")),
            key=lambda n: int(re.search(r"slide(\d+)\.xml", n).group(1)),
        )
        blocks = []
        for i, slide_file in enumerate(slide_files[:limits.max_slides()]):
            root = ElementTree.fromstring(zf.read(slide_file))
            texts = [t.text for t in root.iter(f"{_NS_A}t") if t.text and t.text.strip()]
            blocks.append(f"--- Slide {i + 1} ---\n" + "\n".join(texts))

    out.text = "\n\n".join(blocks)
    out.extractor = "zip+xml"
    out.metadata["slides"] = len(slide_files)
    out.note("Read without python-pptx — speaker notes and shape grouping are "
             "not included. Install python-pptx for those.")
    return out


# ── Images ───────────────────────────────────────────────────────────────────

def _extract_image(data: bytes, ft: FileType, filename: str, **_) -> ExtractedContent:
    """Produce a vision block, converting the format when the model can't take
    it directly.

    A .bmp/.tiff/.heic is a perfectly ordinary thing to attach and no provider
    accepts it inline. Converting to PNG (Pillow) turns "unsupported" into
    "works"; without Pillow the file is reported honestly instead of being sent
    in a format that would fail the whole request.
    """
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type,
                           extractor="passthrough")
    name = os.path.basename(filename) or "image"

    if ft.media_type == "image/svg+xml":  # reached only if detect() routed here
        text, _ = decode_text(data)
        out.text = text
        out.note("SVG is XML — its markup is shown as text, not rendered.")
        return out

    payload, media_type, note = data, ft.media_type, ""
    if not ft.is_vision:
        payload, media_type = _convert_image(data)
        if payload is None:
            return out.note(
                f"{ft.label} cannot be sent to the model directly, and Pillow "
                f"is not installed to convert it (`pip install pillow`). "
                f"Re-attach as PNG or JPEG."
            )
        note = f"Converted from {ft.label} to PNG so it could be read."

    if len(payload) > limits.max_image_bytes():
        shrunk = _downscale_image(payload)
        if shrunk is None:
            return out.note(
                f"Image is {len(payload):,} bytes, over the "
                f"{limits.max_image_bytes():,}-byte vision limit, and Pillow is "
                f"not installed to downscale it. Attach a smaller version."
            )
        payload, media_type = shrunk, "image/jpeg"
        note = (note + " " if note else "") + "Downscaled to fit the size limit."

    width, height = _image_dimensions(data, ft.extension)
    out.images = [ImageBlock.from_bytes(payload, media_type, source=name,
                                        width=width, height=height)]
    if width and height:
        out.metadata["dimensions"] = f"{width}x{height}"
    if note:
        out.note(note.strip())
    return out


def _convert_image(data: bytes):
    """(png_bytes, 'image/png') or (None, None) when Pillow is unavailable."""
    try:
        from PIL import Image
    except ImportError:
        return None, None
    try:
        with Image.open(io.BytesIO(data)) as img:
            # Paletted and alpha modes survive the PNG round-trip; CMYK (from
            # print-ready TIFFs) does not, so it is normalised first.
            if img.mode in ("CMYK", "P", "LA"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue(), "image/png"
    except Exception as e:  # noqa: BLE001
        log.debug("Image conversion failed: %s", e)
        return None, None


def _downscale_image(data: bytes) -> Optional[bytes]:
    """Fit an oversized image under the vision cap. JPEG at quality 80 with a
    2048px long edge is the point where further shrinking starts costing
    legibility of screenshot text, which is most of what gets attached."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB")
            img.thumbnail((2048, 2048))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80, optimize=True)
            result = buf.getvalue()
        return result if len(result) <= limits.max_image_bytes() else None
    except Exception as e:  # noqa: BLE001
        log.debug("Image downscale failed: %s", e)
        return None


def _image_dimensions(data: bytes, ext: str) -> tuple:
    """Pillow when available; otherwise PNG/JPEG/GIF headers, which cover
    almost everything that gets attached."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as img:
            return img.width, img.height
    except Exception:  # noqa: BLE001 — header parsing below
        pass

    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:3] == b"GIF":
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"\xff\xd8":
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    break
                marker = data[i + 1]
                # SOF0/1/2/3 and SOF9/10 carry the frame dimensions; every
                # other marker is a segment to skip by its declared length.
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC9, 0xCA):
                    height, width = struct.unpack(">HH", data[i + 5:i + 9])
                    return width, height
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    except (struct.error, IndexError):
        pass
    return None, None


# ── Audio / video ────────────────────────────────────────────────────────────

def _extract_media(data: bytes, ft: FileType, filename: str,
                   size: int = None, path: str = None) -> ExtractedContent:
    """Container metadata and an honest statement of the limit.

    No production LLM accepts video, and none accepts audio through this
    chat-completions path. "Support for .mp4" is therefore always a
    preprocessing pipeline the server owns: keyframes → vision, audio track →
    speech-to-text. That pipeline needs an ffmpeg binary and a transcription
    service, so it is a deployment decision rather than something to assume
    into existence here.

    What this does instead is the part that costs nothing and still helps: say
    exactly what the file is, and tell the model plainly that it cannot see or
    hear it, so it asks for a transcript or a screenshot instead of
    hallucinating the contents of a video it was told was "attached".
    """
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type,
                           extractor="container-probe")
    out.size_bytes = size or len(data)

    duration = _probe_duration(data, ft)
    if duration:
        out.metadata["duration"] = _format_duration(duration)

    medium = "video" if ft.kind == KIND_VIDEO else "audio"
    out.note(
        f"This is {medium}. I cannot watch or listen to it — no transcript or "
        f"frames were extracted, and none are available on this server."
    )
    out.note(
        "To act on its contents: attach a transcript, paste the relevant "
        "quotes, or attach screenshots of the moments that matter (images ARE "
        "read). The file itself is saved and its path is usable by tools."
    )
    return out


def _probe_duration(data: bytes, ft: FileType) -> Optional[float]:
    """Duration in seconds from the container header, without ffprobe.

    MP4/MOV keep it in the `mvhd` atom and WAV in the fmt/data chunk sizes —
    both are a few bytes at a known offset, so this stays dependency-free.
    Other containers return None rather than a guess.
    """
    try:
        if ft.media_type in ("video/mp4", "video/quicktime", "audio/mp4",
                             "video/x-m4v"):
            index = data.find(b"mvhd")
            if index < 0:
                return None
            version = data[index + 4]
            if version == 1:
                timescale, units = struct.unpack(">IQ", data[index + 20:index + 32])
            else:
                timescale, units = struct.unpack(">II", data[index + 16:index + 24])
            return units / timescale if timescale else None

        if ft.media_type == "audio/wav" and data[:4] == b"RIFF":
            index = data.find(b"fmt ")
            if index < 0:
                return None
            byte_rate = struct.unpack("<I", data[index + 16:index + 20])[0]
            data_index = data.find(b"data", index)
            if data_index < 0 or not byte_rate:
                return None
            data_size = struct.unpack("<I", data[data_index + 4:data_index + 8])[0]
            return data_size / byte_rate
    except (struct.error, IndexError, ZeroDivisionError):
        return None
    return None


def _format_duration(seconds: float) -> str:
    total = int(seconds)
    if total >= 3600:
        return f"{total // 3600}h {(total % 3600) // 60}m {total % 60}s"
    if total >= 60:
        return f"{total // 60}m {total % 60}s"
    return f"{total}s"


# ── Archives ─────────────────────────────────────────────────────────────────

def _extract_archive(data: bytes, ft: FileType, filename: str,
                     size: int = None, path: str = None) -> ExtractedContent:
    """List the contents. Never extract.

    Auto-extraction is how a 42 KB upload becomes 4 GB on disk (a zip bomb),
    and how `../../etc/cron.d/x` inside a tar ends up written outside the
    thread's input directory (Zip Slip). Neither risk is worth taking
    automatically: the listing is what tells the model whether the archive is
    even relevant, and the user can attach the specific files that are.
    """
    out = ExtractedContent(kind=ft.kind, label=ft.label, media_type=ft.media_type,
                           extractor="listing")
    out.size_bytes = size or len(data)
    source = path if path and os.path.exists(path) else io.BytesIO(data)
    cap = limits.max_archive_entries()
    entries, total, uncompressed = [], 0, 0

    try:
        if ft.media_type == "application/zip" or ft.extension in (".zip", ".jar"):
            with zipfile.ZipFile(source) as zf:
                infos = zf.infolist()
                total = len(infos)
                for info in infos[:cap]:
                    uncompressed += info.file_size
                    entries.append(f"{info.filename} ({info.file_size:,} B)")
                uncompressed += sum(i.file_size for i in infos[cap:])
        elif ft.media_type in ("application/x-tar", "application/gzip",
                               "application/x-bzip2", "application/x-xz"):
            import tarfile
            with tarfile.open(name=path if isinstance(source, str) else None,
                              fileobj=None if isinstance(source, str) else source,
                              mode="r:*") as tf:
                for member in tf:
                    total += 1
                    if len(entries) < cap:
                        uncompressed += member.size
                        entries.append(f"{member.name} ({member.size:,} B)")
        else:
            return out.note(
                f"{ft.label} needs an external tool to list. Its contents were "
                f"not inspected."
            )
    except Exception as e:  # noqa: BLE001
        return out.note(f"Archive could not be read ({type(e).__name__}: {e}).")

    out.metadata["entries"] = total
    out.text = "\n".join(entries)
    out.note("Archive contents are LISTED, not extracted. Attach the specific "
             "files you want read, or ask me to extract a named entry.")
    if total > cap:
        out.truncated = True
        out.note(f"Showing {cap} of {total} entries.")
    # A ratio this extreme is the signature of a zip bomb, and it is worth
    # saying out loud before anyone asks for an extraction.
    if out.size_bytes and uncompressed > out.size_bytes * 200:
        out.note(f"Compression ratio is {uncompressed // max(out.size_bytes, 1)}:1 "
                 f"({uncompressed:,} B uncompressed) — treat with caution.")
    return out


# ── Opaque ───────────────────────────────────────────────────────────────────

def _extract_binary(data: bytes, ft: FileType, filename: str,
                    size: int = None, path: str = None) -> ExtractedContent:
    out = ExtractedContent(kind=KIND_BINARY, label=ft.label,
                           media_type=ft.media_type, extractor="none")
    out.size_bytes = size or len(data)
    out.note(
        f"{ft.label} — binary content with no text representation. Nothing was "
        f"extracted. The file is saved and its path can be passed to tools."
    )
    return out


_HANDLERS = {
    KIND_TEXT: _extract_text,
    KIND_TABULAR: _extract_tabular,
    KIND_HTML: _extract_html,
    KIND_NOTEBOOK: _extract_notebook,
    KIND_EMAIL: _extract_email,
    KIND_PDF: _extract_pdf,
    KIND_DOCUMENT: _extract_document,
    KIND_SPREADSHEET: _extract_spreadsheet,
    KIND_PRESENTATION: _extract_presentation,
    KIND_IMAGE: _extract_image,
    KIND_AUDIO: _extract_media,
    KIND_VIDEO: _extract_media,
    KIND_ARCHIVE: _extract_archive,
    KIND_BINARY: _extract_binary,
}
