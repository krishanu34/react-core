"""
Ingestion tests — attachments must be READ, not merely received.

The bugs these lock down were all silent: the model got a filename, or an
empty string, or noise, and answered anyway. So most of what is asserted here
is not "did it parse" but "does the model find out when it did not".

Fixtures are built in-process rather than committed as binaries: the OOXML
formats are ZIP+XML, so a hand-built .xlsx exercises the stdlib fallback path
on a host that has no openpyxl, which is the path most deployments will
actually run.
"""

import io
import os
import struct
import zipfile

import pytest

from agents import vision_buffer
from agents.input_ingestion import _sanitize_filename, ingest_uploads
from ingestion import (
    KIND_ARCHIVE, KIND_BINARY, KIND_DOCUMENT, KIND_IMAGE, KIND_PDF,
    KIND_PRESENTATION, KIND_SPREADSHEET, KIND_TABULAR, KIND_TEXT, KIND_VIDEO,
    decode_text, detect, extract,
)
from llm.model_capabilities import capabilities_for


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _xlsx(sheet_name="Budget"):
    """A minimal but real .xlsx (shared strings + one sheet)."""
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml",
                   f'<workbook xmlns="{ns}"><sheets>'
                   f'<sheet name="{sheet_name}" sheetId="1"/></sheets></workbook>')
        z.writestr("xl/sharedStrings.xml",
                   f'<sst xmlns="{ns}"><si><t>Item</t></si><si><t>Servers</t></si></sst>')
        z.writestr("xl/worksheets/sheet1.xml",
                   f'<worksheet xmlns="{ns}"><sheetData>'
                   f'<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
                   f'<row r="2"><c r="A2" t="s"><v>1</v></c>'
                   f'<c r="B2"><v>4200</v></c></row></sheetData></worksheet>')
    return buf.getvalue()


def _pptx():
    ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("ppt/presentation.xml", "<p/>")
        # slide10 sorts before slide2 lexically — the extractor must order by
        # the number, not the filename.
        for n, title in ((1, "Agenda"), (2, "Architecture"), (10, "Wrap up")):
            z.writestr(f"ppt/slides/slide{n}.xml",
                       f'<sld xmlns:a="{ns}"><a:t>{title}</a:t></sld>')
    return buf.getvalue()


def _mp4(seconds=95):
    mvhd = b"mvhd" + bytes(4) + struct.pack(">IIII", 0, 0, 1000, seconds * 1000)
    return (struct.pack(">I", 20) + b"ftyp" + b"isom" + bytes(8)
            + struct.pack(">I", len(mvhd) + 8) + b"moov" + mvhd)


def _zip_archive():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("src/main.py", "print('hi')\n")
        z.writestr("README.md", "# Project\n")
    return buf.getvalue()


def _png(width=40, height=30):
    pytest.importorskip("PIL")
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buf, format="PNG")
    return buf.getvalue()


# ── Detection ────────────────────────────────────────────────────────────────

def test_declared_content_type_never_overrides_the_bytes():
    """The browser's Content-Type is attacker-controlled. An executable that
    claims image/png must not reach a vision request as an image."""
    exe = b"MZ\x90\x00" + os.urandom(200)
    assert detect(exe, "photo.png", "image/png").kind == KIND_BINARY

    png = _png()
    assert detect(png, "notes.txt", "text/plain").kind == KIND_IMAGE


def test_ooxml_is_told_apart_by_container_members():
    """.docx/.xlsx/.pptx share ZIP magic — only the member list distinguishes
    them, so a mislabelled extension must not decide the format."""
    assert detect(_xlsx(), "anything.bin").kind == KIND_SPREADSHEET
    assert detect(_pptx(), "anything.bin").kind == KIND_PRESENTATION
    assert detect(_zip_archive(), "sheet.xlsx").kind == KIND_ARCHIVE


def test_extensionless_and_unknown_text_still_reads_as_text():
    assert detect(b"FROM python:3.11\n", "Dockerfile").kind == KIND_TEXT
    assert detect(b"resource {}\n", "main.tf").kind == KIND_TEXT
    # No extension, no signature, no known name — the content decides.
    assert detect(b"key = value\n", "somefile").kind == KIND_TEXT


def test_media_and_tabular_detection():
    assert detect(_mp4(), "demo.mp4").kind == KIND_VIDEO
    assert detect(b"a,b\n1,2\n", "x.csv").kind == KIND_TABULAR


# ── Decoding ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,encoding", [
    ("café naïve résumé", "cp1252"),
    ("café naïve 中文", "utf-8"),
    ("hello from powershell", "utf-16-le"),
    ("with a bom", "utf-16"),
])
def test_decode_round_trips_without_mojibake(text, encoding):
    """UTF-16 "succeeds" on any even-length byte string, so trying it before
    cp1252 silently corrupts every Windows-authored file."""
    decoded, _ = decode_text(text.encode(encoding))
    assert decoded == text


# ── Extraction ───────────────────────────────────────────────────────────────

def test_docx_text_is_extracted():
    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_heading("Requirements", 1)
    document.add_paragraph("The system shall support SSO.")
    buf = io.BytesIO()
    document.save(buf)

    result = extract(buf.getvalue(), "spec.docx")
    assert result.kind == KIND_DOCUMENT
    assert "SSO" in result.text
    assert "Requirements" in result.text


def test_xlsx_reads_shared_strings_and_values():
    result = extract(_xlsx(), "budget.xlsx")
    assert result.kind == KIND_SPREADSHEET
    assert "Servers" in result.text   # shared-string cell
    assert "4200" in result.text      # inline numeric cell


def test_pptx_slides_are_ordered_numerically():
    result = extract(_pptx(), "deck.pptx")
    assert result.kind == KIND_PRESENTATION
    assert result.text.index("Architecture") < result.text.index("Wrap up")


def test_pdf_text_layer_is_extracted():
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    doc.new_page().insert_text((72, 100), "ADR-004: use PostgreSQL.")
    data = doc.tobytes()
    doc.close()

    result = extract(data, "adr.pdf")
    assert result.kind == KIND_PDF
    assert "PostgreSQL" in result.text
    assert "--- Page 1 ---" in result.text


def test_scanned_pdf_says_so_and_renders_pages():
    """A PDF with no text layer previously came back empty, and the model
    concluded the document was empty. It must say what happened."""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    page = doc.new_page()
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 80))
    pix.set_rect(pix.irect, (200, 30, 30))
    page.insert_image(fitz.Rect(72, 72, 192, 152), pixmap=pix)
    data = doc.tobytes()
    doc.close()

    result = extract(data, "scan.pdf")
    assert not result.text.strip()
    assert any("no text layer" in note for note in result.notes)
    assert result.images, "a scanned page must be rendered for vision"


def test_csv_reports_shape_and_bounds_rows(monkeypatch):
    monkeypatch.setenv("INGEST_MAX_SHEET_ROWS", "3")
    rows = "\n".join(f"{i},name{i}" for i in range(100))
    result = extract(f"id,name\n{rows}\n".encode(), "big.csv")
    assert result.metadata["rows"] == 101      # header + 100 data rows
    assert result.truncated
    assert any("first 3" in note for note in result.notes)


def test_html_drops_scripts_and_styles():
    html = (b"<html><head><style>b{color:red}</style></head><body>"
            b"<p>Visible</p><script>secret()</script></body></html>")
    result = extract(html, "page.html")
    assert "Visible" in result.text
    assert "secret" not in result.text


def test_archive_is_listed_never_extracted():
    result = extract(_zip_archive(), "bundle.zip")
    assert result.kind == KIND_ARCHIVE
    assert "src/main.py" in result.text
    assert any("not extracted" in note for note in result.notes)


def test_video_states_that_it_cannot_be_watched():
    """The honest-limits contract: an agent told a video is "attached" without
    this note describes footage it never saw."""
    result = extract(_mp4(seconds=95), "demo.mp4")
    assert result.kind == KIND_VIDEO
    assert result.metadata["duration"] == "1m 35s"
    assert any("cannot watch" in note for note in result.notes)
    assert not result.text.strip()


def test_corrupt_file_reports_instead_of_raising():
    """A .docx header on random bytes must cost a note, not the user's turn."""
    broken = b"PK\x03\x04" + os.urandom(500)
    result = extract(broken, "broken.docx")
    assert result.notes
    assert not result.has_content


def test_render_always_says_something_when_nothing_was_extracted():
    rendered = extract(b"MZ\x90\x00" + os.urandom(100), "tool.exe").render()
    assert "No readable text" in rendered or "NOTE:" in rendered


# ── Filename safety ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("hostile,expected_not", [
    ("../../../etc/passwd", ".."),
    ("..\\..\\windows\\system32\\evil.dll", ".."),
    ("/absolute/path.txt", "/"),
])
def test_sanitize_strips_traversal(hostile, expected_not):
    safe = _sanitize_filename(hostile)
    assert expected_not not in safe
    assert os.path.basename(safe) == safe


def test_sanitize_handles_reserved_and_dotted_names():
    assert _sanitize_filename("CON.txt").lower().startswith("con_file")
    assert _sanitize_filename("   ...   ") == "upload"
    assert _sanitize_filename("") == "upload"


# ── The upload path ──────────────────────────────────────────────────────────

def test_uploads_are_saved_parsed_and_contained(tmp_path):
    result = ingest_uploads(str(tmp_path), [
        # A browser reporting a .docx as octet-stream is the common case, and
        # the old code treated "not image/*" as "give the model a filename".
        {"filename": "budget.xlsx", "content": _xlsx(),
         "content_type": "application/octet-stream"},
        {"filename": "../../../etc/passwd", "content": b"root:x:0:0\n",
         "content_type": "text/plain"},
    ])

    assert len(result.files) == 2
    assert all(
        os.path.realpath(f.saved_path).startswith(os.path.realpath(str(tmp_path)))
        for f in result.files
    ), "an upload escaped the input directory"

    workbook = result.files[0]
    assert workbook.detected_type.endswith("spreadsheetml.sheet")
    assert workbook.content_type == "application/octet-stream"  # what was claimed
    assert "Servers" in workbook.extracted.text

    digest = result.digest()
    assert "Servers" in digest, "parsed content must reach the first message"
    assert "budget.xlsx" in digest


def test_duplicate_names_do_not_overwrite(tmp_path):
    result = ingest_uploads(str(tmp_path), [
        {"filename": "a/report.txt", "content": b"first"},
        {"filename": "b\\report.txt", "content": b"second"},
    ])
    paths = {f.saved_path for f in result.files}
    assert len(paths) == 2
    assert {open(p, "rb").read() for p in paths} == {b"first", b"second"}


def test_oversized_upload_is_rejected_out_loud(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_MAX_FILE_BYTES", "1024")
    result = ingest_uploads(str(tmp_path), [
        {"filename": "huge.bin", "content": b"x" * 4096},
        {"filename": "fine.txt", "content": b"ok"},
    ])
    assert len(result.files) == 1
    assert result.rejected and "huge.bin" in result.rejected[0]
    assert "huge.bin" in result.digest()      # the user must be told
    assert not os.path.exists(os.path.join(str(tmp_path), "huge.bin"))


def test_images_are_capped_per_request(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_MAX_IMAGES", "2")
    png = _png()
    result = ingest_uploads(str(tmp_path), [
        {"filename": f"shot{i}.png", "content": png, "content_type": "image/png"}
        for i in range(5)
    ])
    assert len(result.images) == 2
    assert len(result.files) == 5          # all still saved
    assert any("not shown to the model" in reason for reason in result.rejected)


def test_no_attachments_produces_no_digest(tmp_path):
    assert ingest_uploads(str(tmp_path), []).digest() == ""


def test_digest_quotes_the_client_path_when_the_client_has_a_copy(tmp_path):
    """read_file is CLIENT-executed. Telling the model the server's path gives
    it a path the tool that reads it cannot resolve — which is exactly how an
    attached .docx came back as 'File not found'."""
    result = ingest_uploads(
        str(tmp_path),
        [{"filename": "spec.docx", "content": _xlsx(), "content_type": ""}],
        client_paths={"spec.docx": ".devaccel/input/spec.docx"},
    )
    saved = result.files[0]
    assert saved.model_path == ".devaccel/input/spec.docx"
    assert ".devaccel/input/spec.docx" in result.digest()
    assert str(tmp_path) not in result.digest()
    # The server copy still exists — extraction needed the bytes.
    assert os.path.exists(saved.saved_path)
    assert saved.to_event()["client_path"] == ".devaccel/input/spec.docx"


def test_digest_falls_back_to_the_server_path_without_a_client_copy(tmp_path):
    """No local folder access (no daemon, no granted handle) → the server copy
    is the only copy, and it must stay addressable."""
    result = ingest_uploads(
        str(tmp_path), [{"filename": "notes.txt", "content": b"hello"}],
    )
    saved = result.files[0]
    assert saved.client_path == ""
    assert saved.model_path == saved.saved_path
    assert saved.saved_path in result.digest()


# ── Client-executed reads ────────────────────────────────────────────────────

def test_client_tool_images_reach_the_vision_buffer():
    """The browser's read_file parses a local image and returns base64. The
    payloads must move into the vision buffer and OUT of the text result — a
    tool message is capped by the scratchpad budget, and megabytes of base64
    would evict the conversation to say nothing the model can read."""
    from tools.client_delegating_tool import ClientDelegatingTool

    tool = ClientDelegatingTool("read_file", "d", {}, "vision-thread", ".")
    vision_buffer.clear("vision-thread")

    result = tool._siphon_images({
        "path": "ui/mockup.png",
        "type": "image",
        "images": [
            {"mime_type": "image/png", "data": "QUJD", "filename": "mockup.png"},
            {"mime_type": "text/plain", "data": "not-an-image"},   # dropped
            {"mime_type": "image/jpeg", "data": ""},               # dropped
        ],
    })

    assert "images" not in result
    assert result["images_attached"] == 1
    queued = vision_buffer.drain("vision-thread")
    assert len(queued) == 1
    assert queued[0]["mime_type"] == "image/png"


def test_client_tool_result_without_images_is_unchanged():
    from tools.client_delegating_tool import ClientDelegatingTool

    tool = ClientDelegatingTool("read_file", "d", {}, "t", ".")
    assert tool._siphon_images({"path": "a.py", "content": "x"}) == {
        "path": "a.py", "content": "x",
    }


# ── read_file routing ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_read_file_parses_documents_and_queues_images(tmp_path):
    from tools.read_file_tool import ReadFileTool

    (tmp_path / "budget.xlsx").write_bytes(_xlsx())
    (tmp_path / "shot.png").write_bytes(_png())
    (tmp_path / "app.py").write_text("def main():\n    return 1\n")

    tool = ReadFileTool(str(tmp_path))
    tool.thread_id = "thread-under-test"
    vision_buffer.clear(tool.thread_id)

    workbook = await tool.run("budget.xlsx")
    assert "Servers" in workbook["content"]
    assert workbook["type"] == KIND_SPREADSHEET

    source = await tool.run("app.py")
    assert "   1 | def main():" in source["content"]   # line numbers preserved

    image = await tool.run("shot.png")
    assert image["images_attached"] == 1
    queued = vision_buffer.drain(tool.thread_id)
    assert len(queued) == 1
    assert queued[0]["mime_type"] == "image/png"
    assert not vision_buffer.drain(tool.thread_id), "drain must empty the buffer"


@pytest.mark.asyncio
async def test_read_file_windows_a_pdf_by_page(tmp_path):
    fitz = pytest.importorskip("fitz")
    from tools.read_file_tool import ReadFileTool

    doc = fitz.open()
    for i in range(3):
        doc.new_page().insert_text((72, 100), f"Page {i + 1} body text")
    (tmp_path / "doc.pdf").write_bytes(doc.tobytes())
    doc.close()

    tool = ReadFileTool(str(tmp_path))
    tool.thread_id = "t"
    result = await tool.run("doc.pdf", offset=2, limit=1)
    assert result["showing"] == "pages 2-2 of 3"
    assert "Page 2 body" in result["content"]
    assert "Page 1 body" not in result["content"]


@pytest.mark.asyncio
async def test_batch_read_counts_extracted_documents_as_read(tmp_path):
    from tools.batch_read_files_tool import BatchReadFilesTool

    (tmp_path / "budget.xlsx").write_bytes(_xlsx())
    (tmp_path / "notes.md").write_text("# Notes\n")
    (tmp_path / "shot.png").write_bytes(_png())

    tool = BatchReadFilesTool(str(tmp_path))
    tool.thread_id = "batch-thread"
    vision_buffer.clear(tool.thread_id)

    result = await tool.run(["budget.xlsx", "notes.md", "shot.png"])
    assert result["files_read"] == 2          # workbook + markdown
    assert result["files_skipped"] == 1       # the image has no text
    by_path = {entry["path"]: entry for entry in result["results"]}
    assert "Servers" in by_path["budget.xlsx"]["content"]
    # A 15-file batch must never spend the turn's whole image budget.
    assert not vision_buffer.drain(tool.thread_id)
    assert "read_file" in by_path["shot.png"]["note"]


# ── Vision capability ────────────────────────────────────────────────────────

@pytest.mark.parametrize("deployment,expected", [
    ("gpt-4.1", True),
    ("gpt-4o", True),          # the "o" is omni — vision-capable
    ("gpt-5.3-chat", True),
    ("some-unnamed-deployment", True),   # unknown → assume capable
    ("gpt-35-turbo", False),
    ("my-o3-mini", False),
])
def test_vision_capability_by_deployment_name(deployment, expected):
    assert capabilities_for(deployment).supports_vision is expected


def test_vision_capability_env_override(monkeypatch):
    monkeypatch.setenv("LLM_SUPPORTS_VISION", "false")
    assert capabilities_for("gpt-4o").supports_vision is False
