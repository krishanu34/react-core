/**
 * Backend event contract — one shape per SSE `type` the server emits.
 * Payloads mirror react_core/agent/events.py + agent/react_agent.py.
 */

export type AgentEvent =
  | { type: "thread_id"; thread_id: string }
  | { type: "thinking"; step: number }
  | { type: "tool_start"; index?: number; tool: string; input?: unknown }
  | { type: "tool_result"; index?: number; tool: string; result?: unknown }
  | { type: "terminal_start"; command?: string }
  | { type: "terminal_output"; chunk?: string; line?: string }
  | { type: "terminal_done"; exit_code?: number }
  | {
      type: "user_question";
      call_id: string;
      question: string;
      options?: string[];
    }
  | { type: "final"; answer: string; steps?: number }
  | { type: "error"; error: string; trace?: string }
  | { type: "stopped"; reason?: string }
  | { type: "done" }
  // Unknown / forward-compat: anything else the server introduces later.
  | { type: string; [k: string]: unknown };

/**
 * Parse a raw SSE byte stream where every event is a single `data: {...json...}\n\n` block.
 * The JSON always contains a `type` field (see backend `sse_event()`).
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // Concatenate all `data:` lines within the block (SSE spec).
        let data = "";
        for (const rawLine of block.split("\n")) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("data:")) {
            data += line.slice(5).trimStart();
          }
        }
        if (!data) continue;

        try {
          yield JSON.parse(data) as AgentEvent;
        } catch (err) {
          yield {
            type: "error",
            error: `Failed to parse SSE payload: ${(err as Error).message}`,
          };
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
}
