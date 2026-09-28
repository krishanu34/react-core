import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react-dom/test-utils";
import { expect, test, vi } from "vitest";
import AICodeBuilderPanel from "@/components/code-builder/panels/AICodeBuilderPanel";
import * as api from "@/lib/code-builder-api";
import queryKeys from "@/lib/query-keys";
import { useStore } from "@/store/useCodeBuilderStore";

vi.mock("@/lib/code-builder-api", async () => {
  const actual = await vi.importActual<any>("@/lib/code-builder-api");
  return {
    ...actual,
    startPipeline: vi.fn(),
    connectPipelineWs: vi.fn(),
    createProject: vi.fn(),
    uploadZip: vi.fn(),
    uploadFile: vi.fn(),
  };
});

test("WebSocket status message updates React Query cache", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Mock startPipeline to return a run id
  const run = { run_id: "run-1", status: "running" } as any;
  (api.startPipeline as any).mockResolvedValue(run);

  // Fake WebSocket object — handlers will be assigned by component
  const fakeWs: any = { onopen: undefined, onclose: undefined, onmessage: undefined, onerror: undefined, close: vi.fn() };
  (api.connectPipelineWs as any).mockReturnValue(fakeWs);

  // Ensure the Code Builder store has a current project and mode so the component can start
  useStore.setState({
    pipelineMode: "greenfield",
    currentProject: {
      project_id: "p1",
      name: "p1",
      mode: "greenfield",
      description: "test project",
      created_at: new Date().toISOString(),
      status: "ready",
    },
    isBuilderExpanded: true,
  });

  // Spy on QueryClient to observe cache writes
  const spySet = vi.spyOn(qc, "setQueryData");

  render(
    <QueryClientProvider client={qc}>
      <AICodeBuilderPanel />
    </QueryClientProvider>,
  );

  // Fill prompt textarea
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "Please build a small API" } });

  // Click Build button
  const buildButton = screen.getByRole("button", { name: /Build/i });
  fireEvent.click(buildButton);

  // Wait for connectPipelineWs to be called so handlers are assigned, then simulate events
  await waitFor(() => expect(api.connectPipelineWs).toHaveBeenCalled());

  // Simulate WS open
  act(() => {
    if (fakeWs.onopen) fakeWs.onopen();
  });

  // Simulate a status message coming from the server
  const statusMsg = { type: "status", status: "running", steps: [], progress: 12, output_dir: "/tmp/out" };
  act(() => {
    if (fakeWs.onmessage) fakeWs.onmessage({ data: JSON.stringify(statusMsg) });
  });

  // Wait for the QueryClient cache to be written
  await waitFor(() => {
    const cached = qc.getQueryData(queryKeys.codeBuilder.runStatus(run.run_id));
    expect(cached).toMatchObject({ status: "running", progress: 12, output_dir: "/tmp/out" });
    expect(spySet).toHaveBeenCalled();
  });
});
