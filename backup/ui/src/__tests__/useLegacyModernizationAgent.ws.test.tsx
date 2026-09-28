import React from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLegacyModernizationAgent } from "@/hooks/useLegacyModernizationAgent";
import queryKeys from "@/lib/query-keys";

test("legacy modernization pipeline_complete triggers query invalidation", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spyInvalidate = vi.spyOn(qc, "invalidateQueries");

  // Fake WebSocket that the hook will use
  const fakeWs: any = { onopen: undefined, onmessage: undefined, onclose: undefined, onerror: undefined, send: vi.fn(), close: vi.fn() };
  // Replace global WebSocket constructor
  const OriginalWebSocket = (global as any).WebSocket;
  (global as any).WebSocket = vi.fn(() => fakeWs);

  const wrapper = ({ children }: any) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  const { result } = renderHook(() => useLegacyModernizationAgent(), { wrapper });

  // Start a modernization run
  act(() => {
    result.current.startModernization({ project_id: 1, target_stack: "nodejs", workspace_root: "/tmp/ws" });
  });

  // Simulate ws.onopen
  act(() => {
    if (fakeWs.onopen) fakeWs.onopen();
  });

  // Send pipeline_complete event
  const evt = { type: "pipeline_complete", workspace_root: "/tmp/ws", target_stack: "nodejs" };
  act(() => {
    if (fakeWs.onmessage) fakeWs.onmessage({ data: JSON.stringify(evt) });
  });

  // Expect invalidation to have been called for legacy mod projects
  expect(spyInvalidate).toHaveBeenCalled();

  // Restore WebSocket
  (global as any).WebSocket = OriginalWebSocket;
});
