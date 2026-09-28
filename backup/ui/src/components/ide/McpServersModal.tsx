/**
 * McpServersModal — full "MCP Servers" settings page (opened from the chat
 * header gear). Typed Add flow (Command / HTTP / NPM / Pip / Docker) with an
 * env/headers editor, plus list / status / enable / remove. Everything writes
 * the workspace's .mcp.json (single source of truth); the inline toolbar chip
 * stays for quick status.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";
import { invalidateLocalMcpCache } from "@/lib/mcp/mcpClient";
import {
  AddForm,
  AddType,
  McpServerEntry,
  buildServerEntry,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "@/lib/mcp/mcpServers";

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: number | null;
  connectedServers?: string[];
}

type Kv = { key: string; value: string };

const TYPES: { id: AddType; label: string; hint: string }[] = [
  { id: "command", label: "Command (stdio)", hint: "Run a local command that speaks MCP" },
  { id: "http", label: "HTTP / SSE", hint: "Connect to a remote MCP server URL" },
  { id: "npm", label: "NPM Package", hint: "npx -y <package>" },
  { id: "pip", label: "Pip Package", hint: "uvx <package>" },
  { id: "docker", label: "Docker Image", hint: "docker run -i --rm <image>" },
];

const BLANK: AddForm = { type: "command", name: "" };

export default function McpServersModal({ open, onClose, workspaceId, connectedServers }: Props) {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>({ ...BLANK });
  const [kv, setKv] = useState<Kv[]>([]);

  const access = workspaceId != null ? resolveWorkspaceFileAccess(workspaceId) : null;

  const load = useCallback(async () => {
    if (!access) { setServers([]); return; }
    setLoading(true); setError(null);
    try { setServers(await readMcpServers(access)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [access]);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const afterWrite = useCallback(async () => { invalidateLocalMcpCache(); await load(); }, [load]);

  const resetForm = () => { setForm({ ...BLANK }); setKv([]); setAdding(false); setError(null); };

  const onSave = async () => {
    if (!access) return;
    const isHttp = form.type === "http";
    const map: Record<string, string> = {};
    for (const { key, value } of kv) if (key.trim()) map[key.trim()] = value;
    try {
      const entry = buildServerEntry({
        ...form,
        env: isHttp ? undefined : map,
        headers: isHttp ? map : undefined,
      });
      await upsertMcpServer(access, entry);
      resetForm();
      await afterWrite();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggle = async (s: McpServerEntry) => {
    if (!access) return;
    try { await setMcpServerEnabled(access, s.name, !s.enabled); await afterWrite(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const onRemove = async (name: string) => {
    if (!access) return;
    try { await removeMcpServer(access, name); await afterWrite(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!open) return null;
  const connected = new Set(connectedServers ?? []);
  const isHttp = form.type === "http";
  const kvLabel = isHttp ? "Headers" : "Environment variables";

  const input = "w-full h-8 px-2 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-xs text-[var(--ide-text)]";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ide-border)]">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-[var(--ide-text)]">MCP Servers</h2>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" title="Reload" onClick={() => void load()}
              className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button type="button" title="Close" onClick={onClose}
              className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="px-4 py-3 overflow-y-auto">
          <p className="text-[11px] text-[var(--ide-muted)] mb-3">
            External tools & services the agent can use. Saved to this workspace&apos;s <code>.mcp.json</code>.
          </p>

          {!access && (
            <p className="text-[11px] text-amber-300 mb-3">
              Open a local folder (daemon or File System Access) to manage MCP servers.
            </p>
          )}

          {/* server list */}
          <div className="space-y-1.5 mb-3">
            {access && servers.length === 0 && !adding && (
              <div className="text-center py-6 text-[var(--ide-muted)]">
                <Plug className="h-5 w-5 mx-auto mb-1.5 opacity-50" />
                <p className="text-xs">No MCP servers configured</p>
                <p className="text-[10px]">Add one to get started.</p>
              </div>
            )}
            {servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2.5 px-3 py-2 rounded border border-[var(--ide-border)] bg-[var(--ide-bg)]">
                <span title={connected.has(s.name) ? "Connected this session" : s.enabled ? "Enabled" : "Disabled"}
                  className={`h-2 w-2 rounded-full shrink-0 ${connected.has(s.name) ? "bg-emerald-400" : s.enabled ? "bg-[var(--ide-muted)]" : "bg-transparent border border-[var(--ide-muted)]"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[var(--ide-text)] truncate">
                    {s.name}
                    <span className="ml-1.5 text-[9px] px-1 py-px rounded bg-[var(--ide-hover)] text-[var(--ide-muted)]">{s.transport}</span>
                    {s.env && Object.keys(s.env).length > 0 && (
                      <span className="ml-1 text-[9px] px-1 py-px rounded bg-[var(--ide-hover)] text-[var(--ide-muted)]">env: {Object.keys(s.env).length}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--ide-muted)] truncate">
                    {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}
                  </div>
                </div>
                <button type="button" onClick={() => void onToggle(s)} title={s.enabled ? "Disable" : "Enable"}
                  className={`text-[10px] px-2 py-0.5 rounded ${s.enabled ? "bg-emerald-600/20 text-emerald-300" : "bg-[var(--ide-hover)] text-[var(--ide-muted)]"}`}>
                  {s.enabled ? "on" : "off"}
                </button>
                <button type="button" onClick={() => void onRemove(s.name)} title="Remove"
                  className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-red-500/15 text-[var(--ide-muted)] hover:text-red-400">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

          {/* add form */}
          {access && (adding ? (
            <div className="rounded border border-[var(--ide-border)] bg-[var(--ide-bg)] p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AddType })} className={input}>
                  {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="name (e.g. jira)" className={input} />
              </div>
              <p className="text-[10px] text-[var(--ide-muted)]">{TYPES.find((t) => t.id === form.type)?.hint}</p>

              {form.type === "command" && (
                <>
                  <input value={form.command ?? ""} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="command (e.g. npx or full path to .exe)" className={input} />
                  <input value={form.args ?? ""} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="args (space-separated)" className={input} />
                </>
              )}
              {form.type === "http" && (
                <>
                  <input value={form.url ?? ""} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…/mcp" className={input} />
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--ide-muted)]">
                    <input type="checkbox" checked={!!form.sse} onChange={(e) => setForm({ ...form, sse: e.target.checked })} />
                    Legacy SSE transport (leave off for Streamable HTTP)
                  </label>
                </>
              )}
              {(form.type === "npm" || form.type === "pip" || form.type === "docker") && (
                <>
                  <input value={form.pkg ?? ""} onChange={(e) => setForm({ ...form, pkg: e.target.value })}
                    placeholder={form.type === "docker" ? "image (e.g. ghcr.io/org/server)" : "package name"} className={input} />
                  <input value={form.extraArgs ?? ""} onChange={(e) => setForm({ ...form, extraArgs: e.target.value })} placeholder="extra args (optional)" className={input} />
                </>
              )}

              {/* env / headers editor */}
              <div className="pt-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">{kvLabel}</span>
                  <button type="button" onClick={() => setKv([...kv, { key: "", value: "" }])}
                    className="text-[10px] text-emerald-300 hover:underline">+ add</button>
                </div>
                {kv.map((row, i) => (
                  <div key={i} className="flex gap-1.5 mb-1">
                    <input value={row.key} onChange={(e) => setKv(kv.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                      placeholder={isHttp ? "Authorization" : "JIRA_API_TOKEN"} className={`${input} flex-1`} />
                    <input value={row.value} onChange={(e) => setKv(kv.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                      placeholder="value" className={`${input} flex-1`} />
                    <button type="button" onClick={() => setKv(kv.filter((_, j) => j !== i))}
                      className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                {kv.some((r) => /token|key|secret|password/i.test(r.key)) && (
                  <p className="text-[10px] text-amber-300 mt-0.5">Secrets are written to .mcp.json — gitignore it (or use .mcp.local.json).</p>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => void onSave()}
                  className="flex-1 h-8 rounded bg-emerald-600/25 text-emerald-300 text-xs hover:bg-emerald-600/35">Save server</button>
                <button type="button" onClick={resetForm}
                  className="px-3 h-8 rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] text-xs">Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => { setAdding(true); setError(null); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded border border-dashed border-[var(--ide-border)] text-xs text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)] w-full justify-center">
              <Plus className="h-4 w-4" /> Add MCP server
            </button>
          ))}

          <p className="text-[10px] text-[var(--ide-muted)] mt-3">
            Local (Command/NPM/Pip/Docker) servers run on your machine via the daemon; remote HTTP servers are reached by the backend. Changes apply on the next message.
          </p>
        </div>
      </div>
    </div>
  );
}
