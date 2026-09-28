/// <reference types="vitest/globals" />
import { renderHook, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Proves the "browser actually sends it" link end-to-end at the code level:
 * the real useSyncEngine drain → real buildSnapshot → real pushWorkspaceSync →
 * authFetch(POST /workspace-api/workspaces/{id}/sync) with the correct body.
 *
 * Only the two leaves are mocked: IndexedDB (workspaceStore) and the network
 * transport (authFetch). Everything in between is the real shipping code.
 */
const h = vi.hoisted(() => ({
  // workspaceStore
  getOutbox: vi.fn(),
  clearOutboxOp: vi.fn().mockResolvedValue(undefined),
  updateOutboxOpStatus: vi.fn().mockResolvedValue(undefined),
  getAllNodes: vi.fn(),
  getTabs: vi.fn(),
  getPref: vi.fn(),
  getLocalWorkspace: vi.fn(),
  updateLocalWorkspace: vi.fn().mockResolvedValue(undefined),
  // auth transport
  authFetch: vi.fn(),
}));

vi.mock("@/lib/db/workspaceStore", () => ({
  getOutbox: h.getOutbox,
  clearOutboxOp: h.clearOutboxOp,
  updateOutboxOpStatus: h.updateOutboxOpStatus,
  getAllNodes: h.getAllNodes,
  getTabs: h.getTabs,
  getPref: h.getPref,
  getLocalWorkspace: h.getLocalWorkspace,
  updateLocalWorkspace: h.updateLocalWorkspace,
}));

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => h.authFetch(...args),
}));

import { useSyncEngine } from "@/hooks/useSyncEngine";

const WID = 123;

function seedHappyPath() {
  // One pending file op waiting in the outbox, then empty after it's cleared.
  h.getOutbox.mockResolvedValueOnce([{ id: 1, op: "create", path: "src/app.ts", status: "pending" }]);
  h.getOutbox.mockResolvedValue([]);
  h.getLocalWorkspace.mockResolvedValue({
    id: WID, name: "My WS", description: null,
    localPathLabel: "C:/proj", createdAt: 1720000000000, fileCount: 0,
  });
  h.getAllNodes.mockResolvedValue([{ path: "src/app.ts", type: "file" }]);
  h.getTabs.mockResolvedValue([{ path: "src/app.ts", active: true, order: 0 }]);
  h.getPref.mockResolvedValue({ showExplorer: true, showChat: false });
}

describe("useSyncEngine — real drain issues the server sync request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default resolved values cleared above.
    h.clearOutboxOp.mockResolvedValue(undefined);
    h.updateOutboxOpStatus.mockResolvedValue(undefined);
    h.updateLocalWorkspace.mockResolvedValue(undefined);
  });

  it("POSTs a metadata+state snapshot to /workspace-api/workspaces/{id}/sync and clears the outbox", async () => {
    seedHappyPath();
    h.authFetch.mockResolvedValue({ ok: true, json: async () => ({ sync_version: 3 }) });

    renderHook(() => useSyncEngine(WID));

    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());

    // The actual request the browser makes.
    const [url, init] = h.authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/workspace-api/workspaces/${WID}/sync`);
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.client_id).toBeTruthy();
    expect(body.batch_id).toBeTruthy();
    expect(body.local_fs_path).toBe("C:/proj");

    // state MUST precede metadata (server clobbers metadata otherwise — see
    // buildSnapshot comment / the live-verified ordering bug).
    expect(body.operations.map((o: { op: string }) => o.op)).toEqual(["state", "metadata"]);
    const state = body.operations[0].payload;
    const meta = body.operations[1].payload;
    expect(meta.id).toBe(WID);
    expect(meta.fileCount).toBe(1); // reconciled from the node tree (1 file)
    expect(state.active_files).toEqual(["src/app.ts"]);
    expect(state.open_tabs).toHaveLength(1);
    expect(state.layout.showExplorer).toBe(true);

    // On server ack, the drained outbox op is cleared.
    await waitFor(() => expect(h.clearOutboxOp).toHaveBeenCalledWith(WID, 1));
  });

  it("keeps the op queued (requeue, no clear) when the server is unreachable", async () => {
    seedHappyPath();
    h.authFetch.mockRejectedValue(new Error("network down"));

    renderHook(() => useSyncEngine(WID));

    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    // Transient failure → op is put back to "pending", never cleared.
    await waitFor(() => expect(h.updateOutboxOpStatus).toHaveBeenCalledWith(WID, 1, "pending"));
    expect(h.clearOutboxOp).not.toHaveBeenCalled();
  });

  it("does not sync when the outbox is empty", async () => {
    h.getOutbox.mockResolvedValue([]);
    h.getLocalWorkspace.mockResolvedValue({ id: WID, name: "WS", fileCount: 0, createdAt: 1 });
    h.getAllNodes.mockResolvedValue([]);
    h.getTabs.mockResolvedValue([]);
    h.getPref.mockResolvedValue(null);

    renderHook(() => useSyncEngine(WID));

    // Give the mount drain a chance to run, then confirm no network call.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(h.clearOutboxOp).not.toHaveBeenCalled();
  });
});
