import { afterEach, describe, expect, it, vi } from "vitest"
import { streamOpenAIChat } from "./openai-chat"
import type { Message } from "./types"

afterEach(() => vi.unstubAllGlobals())

async function sent(messages: Message[]): Promise<Record<string, unknown>[]> {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]\n\n", { status: 200 }))
  vi.stubGlobal("fetch", fetch)
  for await (const _ of streamOpenAIChat({ baseURL: "http://x/v1", req: { model: "m", tools: [], messages }, signal: new AbortController().signal })) { /* drain */ }
  return (JSON.parse(String(fetch.mock.calls[0]![1].body)) as { messages: Record<string, unknown>[] }).messages
}

describe("streamOpenAIChat", () => {
  it("shows a run of tool pictures as one user message after the last result", async () => {
    const out = await sent([
      { role: "user", text: "open safari" },
      { role: "assistant", toolCalls: [{ id: "a", name: "open_app", arguments: "{}" }, { id: "b", name: "screenshot", arguments: "{}" }] },
      { role: "tool", callId: "a", name: "open_app", result: "Opened.", images: [{ data: "AAA", mime: "image/png" }] },
      { role: "tool", callId: "b", name: "screenshot", result: "The screen.", images: [{ data: "BBB", mime: "image/png" }] },
    ])
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"])
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "a", content: "Opened." })
    expect(out[4]!.content).toEqual([
      { type: "text", text: "The pictures the tool results above returned, in order." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
    ])
  })

  it("adds nothing when the results carry no pictures", async () => {
    const out = await sent([
      { role: "assistant", toolCalls: [{ id: "a", name: "wait", arguments: "{}" }] },
      { role: "tool", callId: "a", name: "wait", result: "Waited." },
      { role: "assistant", text: "done" },
    ])
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"])
  })
})
