/**
 * documentExtract — the client-side extractor that replaced clientTools'
 * "Binary file. Cannot display content." refusal.
 *
 * The refusal was returned WITHOUT opening the file, so these tests care less
 * about parser fidelity than about the two properties that were actually
 * broken: a document in the user's repo is READ, and when it can't be, the
 * model is TOLD why instead of being handed an empty string.
 */

import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  decodeText, detectType, extractDocument, extname,
} from "@/lib/agent/documentExtract";
import { safeAttachmentName } from "@/lib/agent/saveAttachments";

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  return zip.generateAsync({ type: "uint8array" });
}

function docxXml(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  return `<?xml version="1.0"?><w:document xmlns:w="${NS_W}"><w:body>${body}</w:body></w:document>`;
}

const bytes = (s: string) => new TextEncoder().encode(s);

/* ── Detection ───────────────────────────────────────────────────────────── */

describe("detectType", () => {
  it("identifies OOXML by container members, not by extension", async () => {
    const docx = await zipOf({ "word/document.xml": docxXml(["hi"]) });
    // Deliberately mislabelled: the member list is what decides.
    expect((await detectType(docx, "notes.txt")).kind).toBe("document");

    const xlsxLike = await zipOf({ "xl/workbook.xml": "<workbook/>" });
    expect((await detectType(xlsxLike, "anything.bin")).kind).toBe("spreadsheet");

    const plain = await zipOf({ "readme.md": "# hi" });
    expect((await detectType(plain, "bundle.docx")).kind).toBe("archive");
  });

  it("identifies by magic bytes ahead of the name", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await detectType(png, "report.pdf")).kind).toBe("image");

    const pdf = bytes("%PDF-1.7\n...");
    expect((await detectType(pdf, "photo.png")).kind).toBe("pdf");
  });

  it("falls back to a content heuristic for unknown names", async () => {
    expect((await detectType(bytes("FROM node:20\n"), "Dockerfile")).kind).toBe("text");
    const binary = new Uint8Array([1, 2, 0, 3, 4]);
    expect((await detectType(binary, "mystery")).kind).toBe("binary");
  });

  it("extname is case-insensitive and tolerates no extension", () => {
    expect(extname("A/B/Spec.DOCX")).toBe(".docx");
    expect(extname("Makefile")).toBe("");
  });
});

/* ── Decoding ────────────────────────────────────────────────────────────── */

describe("decodeText", () => {
  it("decodes UTF-8 and does not mistake cp1252 for UTF-16", () => {
    expect(decodeText(bytes("café naïve 中文")).text).toBe("café naïve 中文");

    // "café" in windows-1252 is 4 bytes, even-length — the trap that made the
    // Python side decode Windows-authored files as CJK gibberish.
    const cp1252 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const out = decodeText(cp1252);
    expect(out.encoding).toBe("windows-1252");
    expect(out.text).toBe("café");
  });

  it("honours a UTF-16 byte-order mark", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeText(utf16).text).toBe("hi");
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(decodeText(new Uint8Array()).text).toBe("");
  });
});

/* ── Extraction ──────────────────────────────────────────────────────────── */

describe("extractDocument", () => {
  it("reads a .docx that used to be refused outright", async () => {
    const docx = await zipOf({
      "word/document.xml": docxXml([
        "The system shall support SSO via SAML 2.0.",
        "Latency must stay under 200ms at p95.",
      ]),
    });
    const out = await extractDocument(docx, "spec.docx");

    expect(out.kind).toBe("document");
    expect(out.text).toContain("SSO via SAML 2.0");
    expect(out.text).toContain("200ms at p95");
    expect(out.extractor).toBe("jszip+DOMParser");
  });

  it("orders pptx slides numerically, not lexically", async () => {
    const slide = (t: string) => `<sld xmlns:a="${NS_A}"><a:t>${t}</a:t></sld>`;
    const pptx = await zipOf({
      "ppt/presentation.xml": "<p/>",
      "ppt/slides/slide1.xml": slide("Agenda"),
      "ppt/slides/slide2.xml": slide("Architecture"),
      "ppt/slides/slide10.xml": slide("Wrap up"),
    });
    const out = await extractDocument(pptx, "deck.pptx");

    expect(out.kind).toBe("presentation");
    // slide10 sorts before slide2 as a string — the deck must not come out shuffled.
    expect(out.text.indexOf("Architecture")).toBeLessThan(out.text.indexOf("Wrap up"));
    expect(out.metadata.slides).toBe(3);
  });

  it("lists an archive and refuses to extract it", async () => {
    const zip = await zipOf({ "src/main.py": "print(1)\n", "README.md": "# hi" });
    const out = await extractDocument(zip, "bundle.zip");

    expect(out.kind).toBe("archive");
    expect(out.text).toContain("src/main.py");
    expect(out.notes.join(" ")).toMatch(/LISTED, not extracted/);
  });

  it("summarises a CSV instead of dumping every row", async () => {
    const rows = Array.from({ length: 900 }, (_, i) => `${i},item${i}`).join("\n");
    const out = await extractDocument(bytes(`id,name\n${rows}`), "data.csv");

    expect(out.kind).toBe("tabular");
    expect(out.metadata.rows).toBe(901);
    expect(out.truncated).toBe(true);
    expect(out.notes.join(" ")).toMatch(/first 500 of 901 rows/);
  });

  it("strips scripts and styles from HTML", async () => {
    const html = bytes(
      "<html><head><style>b{color:red}</style></head><body>" +
      "<p>Visible</p><script>secret()</script></body></html>",
    );
    const out = await extractDocument(html, "page.html");
    expect(out.text).toContain("Visible");
    expect(out.text).not.toContain("secret");
  });

  it("keeps notebook cell outputs — the traceback is usually the point", async () => {
    const nb = JSON.stringify({
      cells: [{ cell_type: "code", source: ["boom()\n"],
                outputs: [{ traceback: ["ZeroDivisionError: division by zero"] }] }],
      metadata: { kernelspec: { display_name: "Python 3" } },
    });
    const out = await extractDocument(bytes(nb), "run.ipynb");
    expect(out.text).toContain("ZeroDivisionError");
    expect(out.metadata.kernel).toBe("Python 3");
  });

  it("returns an image as a vision payload", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    const out = await extractDocument(png, "shots/mockup.png");

    expect(out.images).toHaveLength(1);
    expect(out.images[0].mime_type).toBe("image/png");
    expect(out.images[0].filename).toBe("mockup.png");
    expect(out.images[0].data).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64, no data: prefix
  });

  it("says plainly that it cannot watch a video", async () => {
    const out = await extractDocument(new Uint8Array([0, 0, 0, 20]), "demo.mp4");
    expect(out.kind).toBe("video");
    expect(out.text).toBe("");
    expect(out.notes.join(" ")).toMatch(/cannot watch or listen/);
  });

  it("reports a corrupt file instead of throwing", async () => {
    // ZIP magic over random bytes — detection routes it to a parser that fails.
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9, 9]);
    const out = await extractDocument(broken, "broken.docx");
    expect(out.notes.length).toBeGreaterThan(0);
    expect(out.text).toBe("");
  });

  it("never returns undefined text or images, whatever the input", async () => {
    for (const [data, name] of [
      [new Uint8Array(), "empty.bin"],
      [bytes("x"), "tiny.txt"],
      [new Uint8Array([0xff, 0xd8, 0xff]), "trunc.jpg"],
    ] as Array<[Uint8Array, string]>) {
      const out = await extractDocument(data, name);
      expect(typeof out.text).toBe("string");
      expect(Array.isArray(out.images)).toBe(true);
      expect(Array.isArray(out.notes)).toBe(true);
    }
  });
});

/* ── Attachment naming ───────────────────────────────────────────────────── */

describe("safeAttachmentName", () => {
  it("strips traversal and keeps the basename", () => {
    expect(safeAttachmentName("../../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("..\\..\\evil.txt")).toBe("evil.txt");
    expect(safeAttachmentName("/abs/path/report.pdf")).toBe("report.pdf");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(safeAttachmentName("   ...   ")).toBe("upload");
    expect(safeAttachmentName("")).toBe("upload");
  });

  it("leaves an ordinary name alone", () => {
    expect(safeAttachmentName("e-commerce_demo.docx")).toBe("e-commerce_demo.docx");
  });
});
