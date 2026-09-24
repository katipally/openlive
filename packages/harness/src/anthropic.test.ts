import { describe, it, expect, vi } from "vitest";
import type { ProviderEvent } from "./types";

// Wire-adapter smoke test: feed a canned Anthropic SSE byte stream through
// streamAnthropic and assert the normalized ProviderEvent sequence — the
// contract collectTurn and every UI consumer depend on.
const SSE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":10}}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"look"}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":1}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
  ``,
].join("\n") + "\n";

let body = SSE;
vi.mock("./retry", () => ({
  fetchWithRetry: async () => new Response(
    new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
    }),
    { status: 200 },
  ),
}));

describe("streamAnthropic wire adapter", () => {
  it("normalizes a canned SSE stream into the ProviderEvent contract", async () => {
    const { streamAnthropic } = await import("./anthropic");
    const events: ProviderEvent[] = [];
    for await (const e of streamAnthropic({
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-test",
      req: { model: "claude-haiku-4-5-20251001", messages: [{ role: "user", text: "hi" }], tools: [] },
      signal: new AbortController().signal,
    })) events.push(e);

    expect(events).toEqual([
      { type: "usage", input: 52, output: 0 }, // input + cache_read
      { type: "text", delta: "Hello" },
      { type: "text", delta: " world" },
      { type: "tool_start", index: 1, id: "tu_1", name: "look" },
      { type: "tool_delta", index: 1, argsDelta: '{"q":1}' },
      { type: "tool_stop", index: 1 },
      { type: "usage", input: 0, output: 7 },
      { type: "done", stopReason: "tool_use" },
      // The adapter always emits a terminal done when the byte stream ends, so a
      // connection cut mid-turn can never leave collectTurn hanging.
      { type: "done", stopReason: "stop" },
    ]);
  });

  // MiniMax's Anthropic endpoint says 0 at message_start and the real input only at
  // message_delta; Anthropic repeats its cumulative input there, which must not double.
  it("reads the input count from message_delta without counting it twice", async () => {
    const { streamAnthropic } = await import("./anthropic");
    const usage = async (start: string, delta: string) => {
      body = [start, delta].map((u, i) => `data: {"type":"${i ? "message_delta" : "message_start"}",${i ? "" : `"message":{"usage":${u}}`}${i ? `"usage":${u}` : ""}}`).join("\n\n") + "\n\n";
      const out: ProviderEvent[] = [];
      for await (const e of streamAnthropic({
        baseURL: "https://api.minimax.io/anthropic/v1",
        apiKey: "sk-test",
        req: { model: "MiniMax-M3", messages: [{ role: "user", text: "hi" }], tools: [] },
        signal: new AbortController().signal,
      })) if (e.type === "usage") out.push(e);
      body = SSE;
      return out;
    };
    expect(await usage(`{"input_tokens":0,"output_tokens":0}`, `{"input_tokens":41,"output_tokens":3,"cache_read_input_tokens":128}`))
      .toEqual([{ type: "usage", input: 0, output: 0 }, { type: "usage", input: 169, output: 3 }]);
    expect(await usage(`{"input_tokens":42}`, `{"input_tokens":42,"output_tokens":7}`))
      .toEqual([{ type: "usage", input: 42, output: 0 }, { type: "usage", input: 0, output: 7 }]);
  });
});
