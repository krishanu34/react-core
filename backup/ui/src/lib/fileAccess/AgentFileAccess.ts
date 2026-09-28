/**
 * AgentFileAccess — FileAccess backed by the local daemon (127.0.0.1).
 *
 * Works over plain HTTP (no secure-context requirement) and is the same
 * transport the CLI/IDE clients use. Bound to a daemon rootId obtained by
 * registering an absolute folder path via agentClient.openRoot().
 */

import type { WsNode } from "@/lib/db/workspaceStore";
import type { FileAccess } from "./types";
import * as agent from "./agentClient";

export class AgentFileAccess implements FileAccess {
  readonly kind = "agent" as const;

  constructor(
    private readonly rootId: string,
    readonly rootLabel: string,
  ) {}

  /** Keys ~/.devaccel/projects/<stateId>/ for this workspace's sessions/memory. */
  get stateId(): string {
    return this.rootId;
  }

  /**
   * Register an absolute local path with the daemon and bind to it.
   * `create` mkdir-p's the folder first (used when saving uploaded files).
   */
  static async open(absPath: string, create = false): Promise<AgentFileAccess> {
    const { rootId, root } = await agent.openRoot(absPath, create);
    return new AgentFileAccess(rootId, root);
  }

  async scan(): Promise<WsNode[]> {
    const nodes = await agent.scan(this.rootId);
    return nodes.map((n) => ({ path: n.path, type: n.type, parentPath: n.parentPath }));
  }
  read(path: string): Promise<string> {
    return agent.readFile(this.rootId, path);
  }
  readBytes(path: string): Promise<Uint8Array> {
    return agent.readFileBytes(this.rootId, path);
  }
  write(path: string, content: string): Promise<void> {
    return agent.writeFile(this.rootId, path, content);
  }
  writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    return agent.writeFileBytes(this.rootId, path, bytes);
  }
  create(path: string, type: "file" | "folder"): Promise<void> {
    return agent.createEntry(this.rootId, path, type);
  }
  remove(path: string): Promise<void> {
    return agent.removeEntry(this.rootId, path);
  }
  rename(oldPath: string, newPath: string): Promise<void> {
    return agent.renameEntry(this.rootId, oldPath, newPath);
  }
  exec(
    command: string,
    timeoutSeconds?: number,
    onLine?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<Record<string, unknown>> {
    return agent.exec(this.rootId, command, timeoutSeconds, onLine) as Promise<Record<string, unknown>>;
  }
  grep(query: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return agent.grepSearch(this.rootId, query, options);
  }
  glob(
    pattern: string,
    searchPath?: string,
    includeIgnored?: boolean,
  ): Promise<Record<string, unknown>> {
    return agent.globSearch(this.rootId, pattern, searchPath, includeIgnored);
  }
}
