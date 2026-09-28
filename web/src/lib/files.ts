/**
 * Web IDE — file listing, read, save.
 *
 * All three endpoints are thread-scoped and sandboxed to the thread's
 * workspace on the server. Save requests can return HTTP 422 with a body
 * of `{ error, issues: [{ line, message }] }`; callers surface those as
 * inline validation errors in the editor.
 */

import { apiUrl } from "./api";

export type FileKind =
  | "feature"
  | "json"
  | "markdown"
  | "yaml"
  | "code"
  | "text";

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: FileKind;
}

export interface FileContent extends FileEntry {
  content: string;
}

export interface ValidationIssue {
  line: number | null;
  message: string;
}

export class FileValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(
      issues.length > 0
        ? `Validation failed: ${issues[0].message}`
        : "Validation failed.",
    );
    this.issues = issues;
    this.name = "FileValidationError";
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export async function listFiles(threadId: string): Promise<FileEntry[]> {
  const res = await fetch(apiUrl(`/api/agent/files/${threadId}`, threadId));
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const body = (await res.json()) as { files: FileEntry[] };
  return body.files ?? [];
}

export async function readFile(
  threadId: string,
  path: string,
): Promise<FileContent> {
  const url = new URL(apiUrl(`/api/agent/files/${threadId}/content`, threadId));
  url.searchParams.set("path", path);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `read failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return (await res.json()) as FileContent;
}

export async function writeFile(
  threadId: string,
  path: string,
  content: string,
): Promise<FileEntry> {
  const res = await fetch(
    apiUrl(`/api/agent/files/${threadId}/content`, threadId),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    },
  );
  if (res.status === 422) {
    const body = (await res.json()) as { issues?: ValidationIssue[] };
    throw new FileValidationError(body.issues ?? []);
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `save failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return (await res.json()) as FileEntry;
}
