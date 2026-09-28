/**
 * Extract text content from uploaded document files.
 *
 * Plain-text formats (txt, md, csv, json, yaml, etc.) are read directly in
 * the browser via FileReader.  Binary formats (pdf, docx, doc, rtf) are sent
 * to the backend parse-document endpoint which uses pdfplumber / python-docx /
 * mammoth to extract text.
 */

const BINARY_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf"]);

const LM_API_BASE = "/lm-api";

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

async function parseViaBackend(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${LM_API_BASE}/legacy-modernization/parse-document`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ??
        `Document parsing failed (${res.status})`,
    );
  }

  const data: { text: string } = await res.json();
  return data.text;
}

/**
 * Extract text content from a File object.  Returns the extracted text or
 * throws on failure.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const ext = getExtension(file.name);

  if (BINARY_EXTENSIONS.has(ext)) {
    return parseViaBackend(file);
  }

  return readAsText(file);
}
