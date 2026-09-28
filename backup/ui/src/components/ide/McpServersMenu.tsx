/**
 * McpServersMenu — inline "MCP Servers" control for the ChatDock toolbar.
 *
 * An EDITOR over the workspace's .mcp.json (single source of truth): list, add,
 * enable/disable, and remove external MCP servers. Reads/writes go through
 * FileAccess (daemon / FS-API), so a CLI/IDE client reading the same file stays
 * in sync. Mirrors the styling of the Permission/Tools dropdowns next to it.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";
import { invalidateLocalMcpCache } from "@/lib/mcp/mcpClient";
import {
  McpServerEntry,
  McpTransport,
  SAFE_NAME,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "@/lib/mcp/mcpServers";

interface Props {
  workspaceId: number | null;
  /** Servers observed connecting in the latest run (for a live status dot). */
  connectedServers?: string[];
  disabled?: boolean;
}

const EMPTY_FORM = {
  name: "",
  transport: "stdio" as McpTransport,
  command: "",
  args: "",
  url: "",
  token: "",
};

export default function McpServersMenu({ workspaceId, connectedServers, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const ref = useRef<HTMLDivElement>(null);

  const access = workspaceId != null ? resolveWorkspaceFileAccess(workspaceId) : null;

  const load = useCallback(async () => {
    if (!access) { setServers([]); return; }
    setLoading(true);
    setError(null);
    try {
      setServers(await readMcpServers(access));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [access]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Any write invalidates the local-server manifest cache so the next message
  // re-starts local servers with the new config.
  const afterWrite = useCallback(async () => {
    invalidateLocalMcpCache();
    await load();
  }, [load]);

  const onToggle = async (s: McpServerEntry) => {
    if (!access) return;
    try {
      await setMcpServerEnabled(access, s.name, !s.enabled);
      await afterWrite();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRemove = async (name: string) => {
    if (!access) return;
    try {
      await removeMcpServer(access, name);
      await afterWrite();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAdd = async () => {
    if (!access) return;
    const name = form.name.trim();
    if (!SAFE_NAME.test(name)) { setError("Name: letters, digits, _ and - only."); return; }
    const entry: McpServerEntry = { name, transport: form.transport, enabled: true };
    if (form.transport === "stdio") {
      if (!form.command.trim()) { setError("Command is required for a local (stdio) server."); return; }
      entry.command = form.command.trim();
      entry.args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
    } else {
      if (!/^https?:\/\//i.test(form.url.trim())) { setError("URL must be http(s)."); return; }
      entry.url = form.url.trim();
      if (form.token.trim()) entry.headers = { Authorization: `Bearer ${form.token.trim()}` };
    }
    try {
      await upsertMcpServer(access, entry);
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await afterWrite();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const connected = new Set(connectedServers ?? []);
  const enabledCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title="MCP servers"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] transition-colors disabled:opacity-40 ${
          open ? "bg-emerald-600/20 text-emerald-300"
               : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
        }`}
      >
        <Plug className="h-3.5 w-3.5" />
        <span>MCP{enabledCount ? ` (${enabledCount})` : ""}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-80 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
          <div className="flex items-center justify-between px-2.5 py-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">MCP Servers · .mcp.json</span>
            <button type="button" title="Reload" onClick={() => void load()}
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {!access && (
            <p className="px-2.5 py-2 text-[11px] text-amber-300">
              Open a local folder (daemon or File System Access) to manage MCP servers.
            </p>
          )}

          {access && servers.length === 0 && !adding && (
            <p className="px-2.5 py-2 text-[11px] text-[var(--ide-muted)]">No servers yet. Add one below.</p>
          )}

          <div className="max-h-52 overflow-y-auto">
            {servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-[var(--ide-hover)]">
                <span
                  title={connected.has(s.name) ? "Connected this session" : s.enabled ? "Enabled" : "Disabled"}
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    connected.has(s.name) ? "bg-emerald-400" : s.enabled ? "bg-[var(--ide-muted)]" : "bg-transparent border border-[var(--ide-muted)]"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[var(--ide-text)] truncate">
                    {s.name}
                    <span className="ml-1.5 text-[9px] px-1 py-px rounded bg-[var(--ide-hover)] text-[var(--ide-muted)]">{s.transport}</span>
                  </div>
                  <div className="text-[10px] text-[var(--ide-muted)] truncate">
                    {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}
                  </div>
                </div>
                <button type="button" onClick={() => void onToggle(s)}
                  title={s.enabled ? "Disable" : "Enable"}
                  className={`text-[9px] px-1.5 py-px rounded ${s.enabled ? "bg-emerald-600/20 text-emerald-300" : "bg-[var(--ide-hover)] text-[var(--ide-muted)]"}`}>
                  {s.enabled ? "on" : "off"}
                </button>
                <button type="button" onClick={() => void onRemove(s.name)} title="Remove"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-red-500/15 text-[var(--ide-muted)] hover:text-red-400">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {error && <p className="px-2.5 py-1 text-[10px] text-red-400">{error}</p>}

          {access && (adding ? (
            <div className="px-2.5 py-2 border-t border-[var(--ide-border)] space-y-1.5">
              <div className="flex gap-1.5">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="name" className="flex-1 min-w-0 h-6 px-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]" />
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as McpTransport })}
                  className="h-6 px-1 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]">
                  <option value="stdio">stdio (local)</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>
              {form.transport === "stdio" ? (
                <>
                  <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder="command (e.g. npx)" className="w-full h-6 px-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]" />
                  <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })}
                    placeholder="args (space-separated)" className="w-full h-6 px-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]" />
                </>
              ) : (
                <>
                  <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://…/mcp" className="w-full h-6 px-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]" />
                  <input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
                    placeholder="bearer token (optional)" className="w-full h-6 px-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]" />
                </>
              )}
              <div className="flex gap-1.5 pt-0.5">
                <button type="button" onClick={() => void onAdd()}
                  className="flex-1 h-6 rounded bg-emerald-600/25 text-emerald-300 text-[11px] hover:bg-emerald-600/35">Save</button>
                <button type="button" onClick={() => { setAdding(false); setError(null); setForm({ ...EMPTY_FORM }); }}
                  className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]"><X className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => { setAdding(true); setError(null); }}
              className="flex items-center gap-1.5 w-full px-2.5 py-1.5 mt-0.5 border-t border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]">
              <Plus className="h-3.5 w-3.5" /> Add server
            </button>
          ))}

          <p className="px-2.5 pt-1 text-[9px] text-[var(--ide-muted)]">
            Local (stdio) servers run on your machine via the daemon. Changes apply on the next message.
          </p>
        </div>
      )}
    </div>
  );
}
