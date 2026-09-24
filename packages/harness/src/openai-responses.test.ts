import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "./types";
import { streamOpenAIResponses } from "./openai-responses";

// The events Ollama's /v1/responses streams for one tool call: the whole
// argument string arrives as a single delta, then a done.
const SSE = [
  `data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"open_app","arguments":""}}`,
  `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"name\\":\\"Safari\\"}"}`,
  `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"name\\":\\"Safari\\"}"}`,
  `data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5}}}`,
].join("\n\n") + "\n\n";

afterEach(() => vi.unstubAllGlobals());

function serve(body: string) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("streamOpenAIResponses", () => {
  it("normalizes a streamed tool call", async () => {
    serve(SSE);
    const out: ProviderEvent[] = [];
    const req = { model: "m", messages: [{ role: "user" as const, text: "open safari" }], tools: [] };
    for await (const e of streamOpenAIResponses({ baseURL: "http://x/v1", req, signal: new AbortController().signal })) out.push(e);
    expect(out).toEqual([
      { type: "tool_start", index: 0, id: "call_1", name: "open_app" },
      { type: "tool_delta", index: 0, argsDelta: '{"name":"Safari"}' },
      { type: "tool_stop", index: 0 },
      { type: "usage", input: 12, output: 5 },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("hands a tool's screenshot back to the model, and a plain result as a string", async () => {
    const fetch = serve(`data: {"type":"response.completed","response":{}}\n\n`);
    const req = {
      model: "m",
      tools: [],
      messages: [
        { role: "assistant" as const, toolCalls: [{ id: "a", name: "screenshot", arguments: "{}" }, { id: "b", name: "wait", arguments: "{}" }] },
        { role: "tool" as const, callId: "a", name: "screenshot", result: "The screen.", images: [{ data: "AAA", mime: "image/png" }] },
        { role: "tool" as const, callId: "b", name: "wait", result: "Waited." },
      ],
    };
    for await (const _ of streamOpenAIResponses({ baseURL: "http://x/v1", req, signal: new AbortController().signal })) { /* drain */ }
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as { input: Record<string, unknown>[] };
    const outputs = body.input.filter((i) => i.type === "function_call_output");
    expect(outputs).toEqual([
      {
        type: "function_call_output", call_id: "a",
        output: [{ type: "input_text", text: "The screen." }, { type: "input_image", image_url: "data:image/png;base64,AAA" }],
      },
      { type: "function_call_output", call_id: "b", output: "Waited." },
    ]);
  });
});
