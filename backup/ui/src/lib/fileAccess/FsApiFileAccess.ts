/**
 * FsApiFileAccess — FileAccess backed by the browser File System Access API.
 *
 * Wraps the existing helpers in ui/src/lib/localFs.ts with NO behavior change,
 * so today's browser flow (HTTPS/localhost) keeps working exactly as before.
 * Bound to a FileSystemDirectoryHandle the user picked via showDirectoryPicker.
 */

import type { WsNode } from "@/lib/db/workspaceStore";
import type { FileAccess } from "./types";
import {
  scanDirectory,
  readFsFile,
  readFsFileBytes,
  writeFsFile,
  writeFsFileBytes,
  createFsEntry,
  deleteFsEntry,
  renameFsFile,
  renameFsFolder,
} from "@/lib/localFs";

export class FsApiFileAccess implements FileAccess {
  readonly kind = "fs-api" as const;
  readonly rootLabel: string;

  constructor(private readonly handle: FileSystemDirectoryHandle) {
    // Browser security only exposes the folder name, not the full path.
    this.rootLabel = handle.name;
  }

  scan(): Promise<WsNode[]> {
    return scanDirectory(this.handle);
  }
  read(path: string): Promise<string> {
    return readFsFile(this.handle, path);
  }
  readBytes(path: string): Promise<Uint8Array> {
    return readFsFileBytes(this.handle, path);
  }
  write(path: string, content: string): Promise<void> {
    return writeFsFile(this.handle, path, content);
  }
  writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    return writeFsFileBytes(this.handle, path, bytes);
  }
  create(path: string, type: "file" | "folder"): Promise<void> {
    return createFsEntry(this.handle, path, type);
  }
  remove(path: string): Promise<void> {
    return deleteFsEntry(this.handle, path);
  }
  rename(oldPath: string, newPath: string, kind: "file" | "folder"): Promise<void> {
    return kind === "folder"
      ? renameFsFolder(this.handle, oldPath, newPath)
      : renameFsFile(this.handle, oldPath, newPath);
  }
}
