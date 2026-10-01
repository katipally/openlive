import { afterEach, describe, expect, it, vi } from "vitest"
import { streamAnthropic } from "./anthropic"
import { streamOpenAIChat } from "./openai-chat"
import { streamOpenAIResponses } from "./openai-responses"
import type { Message } from "./types"

// A transient message rides on one request only: the newest window state after
// the last tool results. Every wire must take it right there, and Anthropic's
// cache breakpoint must sit before it, or each step would re-send the whole
// conversation uncached.

afterEach(() => vi.unstubAllGlobals())

const tools = [{ name: "click", description: "", parameters: { type: "object", properties: {} } }]
const signal = new AbortController().signal

async function body(send: (messages: Message[]) => AsyncIterable<unknown>, messages: Message[]): Promise<any> {
  const fetch = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }))
  vi.stubGlobal("fetch", fetch)
  for await (const _ of send(messages)) { /* drain */ }
  return JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))
}

const anthropic = (messages: Message[]) => body((m) => streamAnthropic({ baseURL: "https://x/v1", req: { model: "m", messages: m, tools }, signal }), messages)
const chat = (messages: Message[]) => body((m) => streamOpenAIChat({ baseURL: "https://x/v1", req: { model: "m", messages: m, tools }, signal }), messages)
const responses = (messages: Message[]) => body((m) => streamOpenAIResponses({ baseURL: "https://x/v1", req: { model: "m", messages: m, tools }, signal }), messages)

const ask: Message[] = [{ role: "system", text: "Be brief." }, { role: "user", text: "press save" }]
const step = (id: string): Message[] => [
  { role: "assistant", toolCalls: [{ id, name: "click", arguments: "{}" }] },
  { role: "tool", callId: id, name: "click", result: "Done (AXPress), and read back.\nNotes, window 7.\n[state kept elsewhere]" },
]
const tail = (n: number): Message => ({ role: "user", text: `The newest window state:\n${n} button Save`, images: [{ data: `JPG${n}`, mime: "image/jpeg" }], transient: true })

/** A request with the cache markers taken out: what Anthropic compares to find a cached prefix. */
const bare = (v: unknown) => JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x))

describe("a transient tail", () => {
  it("joins Anthropic's last user turn after its tool_result, behind the cache breakpoint", async () => {
    const sent = await anthropic([...ask, ...step("a"), tail(1)])
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"])
    const turn = sent.messages[2].content
    expect(turn.map((b: { type: string }) => b.type)).toEqual(["tool_result", "text", "image"])
    expect(turn[0].cache_control).toEqual({ type: "ephemeral" })
    expect(turn[1].cache_control).toBeUndefined()
    expect(turn[2]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JPG1" } })
  })

  it("leaves every earlier byte of an Anthropic request alone, step after step", async () => {
    const steps: any[] = []
    const transcript: Message[] = [...ask]
    for (let n = 1; n <= 4; n++) {
      transcript.push(...step(`s${n}`))
      steps.push(await anthropic([...transcript, tail(n)]))
    }
    for (let n = 1; n < steps.length; n++) {
      const prev = steps[n - 1], next = steps[n]
      expect(bare(next.system)).toBe(bare(prev.system))
      expect(bare(next.tools)).toBe(bare(prev.tools))
      // The previous request without its tail is where this one's cache read stops.
      const cached = prev.messages.map((m: { content: unknown[] }, i: number, all: unknown[]) => (i === all.length - 1 ? { ...m, content: m.content.slice(0, 1) } : m))
      expect(bare(next.messages.slice(0, cached.length))).toBe(bare(cached))
    }
    // One state per request, and the newest.
    const shown = (b: any) => JSON.stringify(b.messages).match(/button Save/g)?.length
    expect(steps.map(shown)).toEqual([1, 1, 1, 1])
    expect(JSON.stringify(steps.at(-1).messages.at(-1))).toContain("4 button Save")
  })

  it("follows the tool results as a user message on Chat Completions", async () => {
    const sent = await chat([...ask, ...step("a"), tail(1)])
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"])
    expect(sent.messages[4].content).toEqual([
      { type: "text", text: "The newest window state:\n1 button Save" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,JPG1" } },
    ])
  })

  it("follows the function call output as a user input on the Responses API", async () => {
    const sent = await responses([...ask, ...step("a"), tail(1)])
    expect(sent.input.map((i: { type?: string; role?: string }) => i.type ?? i.role)).toEqual(["user", "function_call", "function_call_output", "user"])
    expect(sent.input[3].content).toEqual([
      { type: "input_text", text: "The newest window state:\n1 button Save" },
      { type: "input_image", image_url: "data:image/jpeg;base64,JPG1" },
    ])
  })

  it("starts its own Anthropic turn when nothing is in front of it to join", async () => {
    const sent = await anthropic([{ role: "assistant", text: "hi" }, tail(1)])
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(["assistant", "user"])
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(sent.messages[1].content[0].cache_control).toBeUndefined()
  })
})

describe("a live view on a user turn", () => {
  const view = (n: number): Message => ({ role: "user", text: "[the screen, live]", images: [{ data: `SCR${n}`, mime: "image/jpeg" }], transient: true })
  const said = (n: number): Message => ({ role: "user", text: `turn ${n}\n\n[screen frame shared]` })
  const reply = (n: number): Message => ({ role: "assistant", text: `reply ${n}` })

  it("joins the user's words on Anthropic, after the cache breakpoint, and earlier turns never change", async () => {
    const turns: any[] = []
    const transcript: Message[] = [...ask]
    for (let n = 1; n <= 3; n++) {
      transcript.push(said(n))
      turns.push(await anthropic([...transcript, view(n)]))
      transcript.push(reply(n))
    }
    const last = turns.at(-1).messages.at(-1).content
    expect(last.map((b: { type: string }) => b.type)).toEqual(["text", "text", "image"])
    expect(last[0].cache_control).toEqual({ type: "ephemeral" })
    expect(last.slice(1).every((b: { cache_control?: unknown }) => !b.cache_control)).toBe(true)
    for (let n = 1; n < turns.length; n++) {
      const prev = turns[n - 1].messages
      const cached = prev.map((m: { content: unknown[] }, i: number) => (i === prev.length - 1 ? { ...m, content: m.content.slice(0, 1) } : m))
      expect(bare(turns[n].messages.slice(0, cached.length))).toBe(bare(cached))
    }
    expect(turns.map((b) => JSON.stringify(b.messages).match(/SCR\d/g))).toEqual([["SCR1"], ["SCR2"], ["SCR3"]])
  })

  it("follows the user's words as its own user message on both OpenAI wires", async () => {
    const c = await chat([...ask, said(1), view(1)])
    expect(c.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "user", "user"])
    expect(c.messages[3].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,SCR1" } })
    const r = await responses([...ask, said(1), view(1)])
    expect(r.input.map((i: { role: string }) => i.role)).toEqual(["user", "user", "user"])
    expect(r.input[2].content[1]).toEqual({ type: "input_image", image_url: "data:image/jpeg;base64,SCR1" })
  })
})
