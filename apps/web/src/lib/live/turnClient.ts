import { createSseDecoder, type SseEvent } from "@openlive/shared";

// Replaces the WebSocket: one live turn = one streaming POST to /api/turn. The
// reply streams back as SSE (same event union as before). Barge-in = abort the
// signal → the fetch aborts → the server's request signal aborts → the LLM stops.
export async function streamTurn(
  body: unknown,
  onSse: (e: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    if (signal.aborted) return; // barge-in
    onSse({ type: "error", message: `Couldn't reach the model: ${String(e?.message ?? e)}` });
    return;
  }
  if (!res.ok || !res.body) {
    onSse({ type: "error", message: `Turn failed (HTTP ${res.status}).` });
    return;
  }
  const decode = createSseDecoder();
  const reader = res.body.getReader();
  const td = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const e of decode(td.decode(value, { stream: true }))) onSse(e);
    }
  } catch {
    // aborted mid-stream (barge-in) or network drop — the engine already stopped audio.
  }
}
