"use client";

/**
 * McpServersPanel — the "MCP Servers" sidebar view (activity bar → Plug icon).
 *
 * Inline sidebar panel (like ExplorerTree / SearchView) to add / enable /
 * disable / remove external MCP servers. Typed Add flow (Command / HTTP / NPM /
 * Pip / Docker) with an env/headers editor. Everything writes the workspace's
 * .mcp.json — single source of truth.
 */

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";
import { invalidateLocalMcpCache } from "@/lib/mcp/mcpClient";
import { putFile, enqueueOutbox } from "@/lib/db/workspaceStore";
import {
  AddForm,
  AddType,
  McpServerEntry,
  buildServerEntry,
  importServersJson,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "@/lib/mcp/mcpServers";

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "jira": {
      "command": "C:/path/to/mcp-atlassian.exe",
      "args": [],
      "env": { "JIRA_URL": "https://…", "JIRA_API_TOKEN": "…" }
    }
  }
}`;

type Kv = { key: string; value: string };

const TYPES: { id: AddType; label: string; hint: string }[] = [
  { id: "command", label: "Command (stdio)", hint: "Run a local command that speaks MCP" },
  { id: "http", label: "HTTP / SSE", hint: "Connect to a remote MCP server URL" },
  { id: "npm", label: "NPM Package", hint: "npx -y <package>" },
  { id: "pip", label: "Pip Package", hint: "uvx <package>" },
  { id: "docker", label: "Docker Image", hint: "docker run -i --rm <image>" },
];

const BLANK: AddForm = { type: "command", name: "" };

/** Reverse-map a saved server into the editable form (pre-fills credentials).
 *  Stored stdio servers show as "Command" (the canonical form after a preset). */
function formFromEntry(s: McpServerEntry): { form: AddForm; kv: { key: string; value: string }[] } {
  if (s.transport === "http" || s.transport === "sse") {
    return {
      form: { type: "http", name: s.name, url: s.url ?? "", sse: s.transport === "sse" },
      kv: Object.entries(s.headers ?? {}).map(([key, value]) => ({ key, value })),
    };
  }
  return {
    form: { type: "command", name: s.name, command: s.command ?? "", args: (s.args ?? []).join(" ") },
    kv: Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })),
  };
}

export function McpServersPanel({ workspaceId }: { workspaceId: number | null }) {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>({ ...BLANK });
  const [kv, setKv] = useState<Kv[]>([]);
  // Raw-JSON paste mode: drop in a full .mcp.json verbatim (no field mangling).
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  // Name of the server being edited (null when adding a new one). Locks the
  // name field so an edit updates the same entry instead of orphaning it.
  const [editingName, setEditingName] = useState<string | null>(null);

  const access = workspaceId != null ? resolveWorkspaceFileAccess(workspaceId) : null;

  const load = useCallback(async () => {
    if (!access) { setServers([]); return; }
    setLoading(true); setError(null);
    try { setServers(await readMcpServers(access)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [access]);

  useEffect(() => { void load(); }, [load]);

  // Workspace switched → clear any in-progress form + the previous workspace's
  // list so a save can NEVER target the old folder. load() (above) then reloads
  // for the new workspace's .mcp.json.
  useEffect(() => {
    setForm({ ...BLANK }); setKv([]); setAdding(false);
    setEditingName(null); setError(null); setSavedMsg(null); setServers([]);
  }, [workspaceId]);

  // After any panel write: invalidate the MCP start-cache, MIRROR the fresh
  // .mcp.json into the app's workspace store (so the Monaco editor + Explorer
  // reflect it instead of showing a stale copy), then reload the list.
  const afterWrite = useCallback(async () => {
    invalidateLocalMcpCache();
    if (workspaceId != null && access) {
      try {
        const content = await access.read(".mcp.json");
        await putFile(workspaceId, { path: ".mcp.json", content, updatedAt: Date.now() });
        await enqueueOutbox(workspaceId, { op: "update", path: ".mcp.json" });
      } catch { /* best-effort — the disk write already succeeded */ }
    }
    await load();
  }, [load, workspaceId, access]);
  const resetForm = () => {
    setForm({ ...BLANK }); setKv([]); setAdding(false); setEditingName(null);
    setJsonMode(false); setJsonText(""); setError(null);
  };

  const onImportJson = async () => {
    if (!access) { setError("No folder access — open this workspace's local folder first."); return; }
    try {
      const names = await importServersJson(access, jsonText);
      await afterWrite(); // invalidate + mirror to editor/Explorer + reload list
      resetForm();
      setSavedMsg(`Imported ${names.length} server${names.length === 1 ? "" : "s"} to .mcp.json ✓`);
      setTimeout(() => setSavedMsg(null), 3500);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const onEdit = (s: McpServerEntry) => {
    const { form: f, kv: rows } = formFromEntry(s);
    setForm(f); setKv(rows); setEditingName(s.name); setAdding(true); setError(null);
  };

  const onSave = async () => {
    if (!access) {
      setError("No folder access — open this workspace's local folder (daemon or File System Access) first.");
      return;
    }
    const isHttp = form.type === "http";
    const map: Record<string, string> = {};
    for (const { key, value } of kv) if (key.trim()) map[key.trim()] = value;
    try {
      const entry = buildServerEntry({ ...form, env: isHttp ? undefined : map, headers: isHttp ? map : undefined });
      // Preserve the current enabled state when editing an existing server.
      const existing = servers.find((s) => s.name === entry.name);
      if (existing) entry.enabled = existing.enabled;
      await upsertMcpServer(access, entry);
      await afterWrite(); // invalidate + mirror to editor/Explorer + reload list
      // Verify the write actually landed — surface a clear error if .mcp.json
      // didn't update (e.g. no write access), instead of silently "losing" it.
      const after = await readMcpServers(access);
      setServers(after);
      if (!after.some((s) => s.name === entry.name)) {
        setError(`Saved but '${entry.name}' isn't in .mcp.json — check folder write access.`);
        return;
      }
      resetForm();
      setSavedMsg(`Saved “${entry.name}” to .mcp.json ✓`);
      setTimeout(() => setSavedMsg(null), 3500);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
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

  const isHttp = form.type === "http";
  const kvLabel = isHttp ? "Headers" : "Environment variables";
  const inputCls = "w-full h-7 px-2 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)]";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="px-2 py-1 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)]">MCP SERVERS</span>
          <button type="button" title="Reload" onClick={() => void load()}
            className="h-4 w-4 inline-flex items-center justify-center rounded text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {/* Exact target file — so you always see WHICH workspace it writes to. */}
        {access && (
          <div className="text-[9px] text-[var(--ide-muted)] truncate" title={`${access.rootLabel}/.mcp.json`}>
            → {access.rootLabel}/.mcp.json
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {!access && (
          <p className="text-[11px] text-amber-300 py-2">
            Open a local folder (daemon or File System Access) to manage MCP servers.
          </p>
        )}

        {access && servers.length === 0 && !adding && (
          <div className="text-center py-6 text-[var(--ide-muted)]">
            <Plug className="h-5 w-5 mx-auto mb-1.5 opacity-50" />
            <p className="text-[11px]">No MCP servers</p>
            <p className="text-[10px]">Add one below.</p>
          </div>
        )}

        {/* server list */}
        <div className="space-y-1">
          {servers.map((s) => (
            <div key={s.name} className="px-2 py-1.5 rounded border border-[var(--ide-border)] bg-[var(--ide-bg)]">
              <div className="flex items-center gap-1.5">
                <span title={s.enabled ? "Enabled" : "Disabled"}
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${s.enabled ? "bg-emerald-400" : "bg-transparent border border-[var(--ide-muted)]"}`} />
                <span className="flex-1 min-w-0 text-[11px] text-[var(--ide-text)] truncate">{s.name}</span>
                <span className="text-[9px] px-1 py-px rounded bg-[var(--ide-hover)] text-[var(--ide-muted)]">{s.transport}</span>
                <button type="button" onClick={() => void onToggle(s)} title={s.enabled ? "Disable" : "Enable"}
                  className={`text-[9px] px-1.5 py-px rounded ${s.enabled ? "bg-emerald-600/20 text-emerald-300" : "bg-[var(--ide-hover)] text-[var(--ide-muted)]"}`}>
                  {s.enabled ? "on" : "off"}
                </button>
                <button type="button" onClick={() => onEdit(s)} title="Edit"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]">
                  <Pencil className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => void onRemove(s.name)} title="Remove"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-red-500/15 text-[var(--ide-muted)] hover:text-red-400">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="mt-0.5 pl-3 flex items-center gap-1 min-w-0">
                {(() => {
                  const kv = s.transport === "stdio" ? s.env : s.headers;
                  const n = kv ? Object.keys(kv).length : 0;
                  return n > 0 ? (
                    <span className="text-[9px] px-1 py-px rounded bg-emerald-600/15 text-emerald-300 shrink-0">
                      {s.transport === "stdio" ? "env" : "headers"}: {n}
                    </span>
                  ) : null;
                })()}
                <span className="text-[10px] text-[var(--ide-muted)] truncate">
                  {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}
                </span>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-[10px] text-red-400 mt-1.5">{error}</p>}
        {savedMsg && <p className="text-[10px] text-emerald-400 mt-1.5">{savedMsg}</p>}

        {/* add form */}
        {access && (jsonMode ? (
          <div className="mt-2 rounded border border-[var(--ide-border)] bg-[var(--ide-bg)] p-2 space-y-1.5">
            <div className="text-[10px] font-semibold text-[var(--ide-text)]">Paste .mcp.json</div>
            <p className="text-[9px] text-[var(--ide-muted)]">Paste a full config verbatim — nothing gets reformatted. Merges with existing servers.</p>
            <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false}
              placeholder={JSON_PLACEHOLDER} rows={10}
              className="w-full px-2 py-1.5 rounded bg-[var(--ide-bg)] border border-[var(--ide-border)] text-[10px] font-mono text-[var(--ide-text)] resize-y" />
            <div className="flex gap-1.5">
              <button type="button" onClick={() => void onImportJson()}
                className="flex-1 h-7 rounded bg-emerald-600/25 text-emerald-300 text-[11px] hover:bg-emerald-600/35">Import</button>
              <button type="button" onClick={resetForm} className="px-2 h-7 rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] text-[11px]">Cancel</button>
            </div>
          </div>
        ) : adding ? (
          <div className="mt-2 rounded border border-[var(--ide-border)] bg-[var(--ide-bg)] p-2 space-y-1.5">
            <div className="text-[10px] font-semibold text-[var(--ide-text)]">
              {editingName ? `Edit “${editingName}”` : "New MCP server"}
            </div>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AddType })} className={inputCls}>
              {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <p className="text-[10px] text-[var(--ide-muted)]">{TYPES.find((t) => t.id === form.type)?.hint}</p>
            <input value={form.name} readOnly={!!editingName}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="name (e.g. jira)"
              className={`${inputCls} ${editingName ? "opacity-60 cursor-not-allowed" : ""}`} />

            {form.type === "command" && (
              <>
                <input value={form.command ?? ""} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="command or full path to .exe" className={inputCls} />
                <input value={form.args ?? ""} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="args (space-separated)" className={inputCls} />
              </>
            )}
            {form.type === "http" && (
              <>
                <input value={form.url ?? ""} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…/mcp" className={inputCls} />
                <label className="flex items-center gap-1.5 text-[10px] text-[var(--ide-muted)]">
                  <input type="checkbox" checked={!!form.sse} onChange={(e) => setForm({ ...form, sse: e.target.checked })} />
                  Legacy SSE (leave off for Streamable HTTP)
                </label>
              </>
            )}
            {(form.type === "npm" || form.type === "pip" || form.type === "docker") && (
              <>
                <input value={form.pkg ?? ""} onChange={(e) => setForm({ ...form, pkg: e.target.value })}
                  placeholder={form.type === "docker" ? "image" : "package name"} className={inputCls} />
                <input value={form.extraArgs ?? ""} onChange={(e) => setForm({ ...form, extraArgs: e.target.value })} placeholder="extra args (optional)" className={inputCls} />
              </>
            )}

            {/* env / headers */}
            <div className="pt-0.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] uppercase tracking-wider text-[var(--ide-muted)]">{kvLabel}</span>
                <button type="button" onClick={() => setKv([...kv, { key: "", value: "" }])} className="text-[10px] text-emerald-300 hover:underline">+ add</button>
              </div>
              {kv.map((row, i) => (
                <div key={i} className="flex gap-1 mb-1">
                  <input value={row.key} onChange={(e) => setKv(kv.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                    placeholder={isHttp ? "Authorization" : "JIRA_API_TOKEN"} className={`${inputCls} flex-1`} />
                  <input value={row.value} onChange={(e) => setKv(kv.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                    placeholder="value" className={`${inputCls} flex-1`} />
                  <button type="button" onClick={() => setKv(kv.filter((_, j) => j !== i))}
                    className="h-7 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {kv.some((r) => /token|key|secret|password/i.test(r.key)) && (
                <p className="text-[9px] text-amber-300">Secrets go to .mcp.json — gitignore it / use .mcp.local.json.</p>
              )}
            </div>

            <div className="flex gap-1.5 pt-0.5">
              <button type="button" onClick={() => void onSave()}
                className="flex-1 h-7 rounded bg-emerald-600/25 text-emerald-300 text-[11px] hover:bg-emerald-600/35">{editingName ? "Update" : "Save"}</button>
              <button type="button" onClick={resetForm} className="px-2 h-7 rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] text-[11px]">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-1.5">
            <button type="button" onClick={() => { setAdding(true); setError(null); }}
              className="flex-1 flex items-center gap-1.5 justify-center px-2 py-1.5 rounded border border-dashed border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]">
              <Plus className="h-3.5 w-3.5" /> Add server
            </button>
            <button type="button" onClick={() => { setJsonMode(true); setError(null); }}
              className="px-2 py-1.5 rounded border border-dashed border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]">
              Paste JSON
            </button>
          </div>
        ))}

        <p className="text-[9px] text-[var(--ide-muted)] mt-2 leading-relaxed">
          Local servers run on your machine via the daemon; remote HTTP servers are reached by the backend. Changes apply on the next message.
        </p>
      </div>
    </div>
  );
}

export default McpServersPanel;
