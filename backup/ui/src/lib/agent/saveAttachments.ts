/**
 * saveAttachments — an attached file's canonical copy belongs on the USER's
 * machine, not on the server.
 *
 * What this changes, and why it matters beyond policy:
 *
 * Attachments used to live only at `.devaccel/{thread_id}/input/` on the
 * SERVER. But `read_file` is a CLIENT tool — it runs here, against the user's
 * real folder. So the model was handed a server path and a tool that could
 * only see the client's disk. Asking it to read its own attachment produced
 * "File not found" (or worse, a stale match), because the two halves of the
 * system disagreed about where the file was.
 *
 * Writing the attachment into the user's workspace first makes the path the
 * model is given a path that actually resolves, on the machine where the tool
 * runs. The data-residency win — CLAUDE.md's "client files remain on the
 * client machine" — comes with it rather than costing anything.
 *
 * The bytes are still POSTed once so the server's extractor can parse them
 * (it is the better extractor and the only one that renders scanned PDF pages
 * for vision). The server deletes its copy when the run ends; this one is
 * what persists.
 */

import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";

/** Where attachments land inside the user's workspace. */
export const ATTACHMENT_DIR = ".devaccel/input";

export interface SavedAttachment {
  /** The name the user attached it under. */
  filename: string;
  /** Workspace-relative path on the USER's disk, e.g. ".devaccel/input/spec.docx". */
  clientPath: string;
}

/**
 * Reduce a browser-supplied filename to something safe to join onto a path.
 * `File.name` has no directory component in practice, but it is user-supplied
 * data reaching a filesystem write, so it is treated as untrusted anyway —
 * same rule as the server's `_sanitize_filename`.
 */
export function safeAttachmentName(name: string): string {
  const base = (name || "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.trim().replace(/^[.\s]+|[.\s]+$/g, "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned.replace(/[._]/g, "")) return "upload";
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** Marker file that makes `.devaccel/` invisible to git. Self-ignoring: the
 *  `*` covers everything including this file itself. */
const GITIGNORE_PATH = ".devaccel/.gitignore";
const GITIGNORE_BODY =
  "# Created by DevSphere. This folder holds attachments and agent state for\n" +
  "# your local session — it is not part of your project and should not be\n" +
  "# committed. Delete the folder any time; it is rebuilt as needed.\n" +
  "*\n";

/**
 * Write the ignore marker once per workspace.
 *
 * Never throws and never blocks: a workspace that isn't a git repo, or a
 * read-only mount, simply doesn't get one — that is a cosmetic loss, and
 * failing an attachment save over it would be absurd. Existing files are left
 * alone so a user who edited theirs keeps their version.
 */
async function ensureIgnored(access: { read: (p: string) => Promise<string>; write: (p: string, c: string) => Promise<void> }) {
  try {
    await access.read(GITIGNORE_PATH);
    return; // already there
  } catch {
    /* missing — create it below */
  }
  try {
    await access.write(GITIGNORE_PATH, GITIGNORE_BODY);
  } catch {
    /* best effort */
  }
}

/**
 * Write each attachment into the workspace on the user's machine.
 *
 * Best-effort by design: a workspace with no local access (no daemon, no
 * granted folder handle) still sends its attachments to the server, which is
 * the pre-existing behaviour. Returning fewer entries than were passed in is
 * therefore normal, not an error — the caller reports what was saved and lets
 * the upload carry the rest.
 *
 * Name collisions get a numeric suffix rather than overwriting: two files
 * attached in one message can sanitise to the same name, and an attachment
 * silently replacing an earlier one is a data-loss bug on the user's own disk.
 */
export async function saveAttachmentsToWorkspace(
  workspaceId: number | null | undefined,
  files: File[],
): Promise<SavedAttachment[]> {
  if (workspaceId == null || files.length === 0) return [];

  // Resolving access must never stop a message being sent. Saving locally is
  // an improvement on the upload path, not a precondition for it.
  let access;
  try {
    access = resolveWorkspaceFileAccess(workspaceId);
  } catch {
    return [];
  }
  if (!access) return [];

  // Keep our bookkeeping out of the user's version control. `.devaccel/` holds
  // attachments and agent state — useful to them locally, never something they
  // meant to commit. Writing a self-ignoring .gitignore INSIDE the folder is
  // the standard trick (the same one npm/pip caches use): it needs no edit to
  // the project's own .gitignore, which is a tracked file we have no business
  // rewriting, and it works even if the project has no .gitignore at all.
  await ensureIgnored(access);

  const used = new Set<string>();
  const saved: SavedAttachment[] = [];

  for (const file of files) {
    let name = safeAttachmentName(file.name);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 1;
      while (used.has(`${stem}_${n}${ext}`)) n++;
      name = `${stem}_${n}${ext}`;
    }
    used.add(name);

    const clientPath = `${ATTACHMENT_DIR}/${name}`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await access.writeBytes(clientPath, bytes);
      saved.push({ filename: file.name, clientPath });
    } catch {
      // One unwritable file must not stop the others, and must not stop the
      // message being sent — the upload path still carries its contents.
    }
  }
  return saved;
}
