import { afterEach, describe, expect, it, vi } from "vitest"
import { streamProvider } from "./index"
import type { ChatRequest, ProviderInfo } from "./types"

afterEach(() => vi.unstubAllGlobals())

const tools = [{ name: "look", description: "", parameters: {} }]
const req = (model: string): ChatRequest => ({ model, tools, messages: [{ role: "user", text: "hi" }] })
const provider = (id: string, protocol: ProviderInfo["protocol"]): ProviderInfo => ({ id, name: id, protocol, baseURL: `http://${id}/v1` })
const ok = () => new Response('data: {"choices":[{"delta":{"content":"hey"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })
const refuse = () => new Response("registry.ollama.ai/library/m does not support tools", { status: 400 })

async function run(p: ProviderInfo, r: ChatRequest) {
  const out: string[] = []
  for await (const ev of streamProvider(p, undefined, r, new AbortController().signal)) out.push(ev.type)
  return out
}
const toolsSent = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map((c) => (JSON.parse(String(c[1].body)) as { tools?: unknown[] }).tools?.length ?? 0)

describe("streamProvider without tools", () => {
  it("retries a 400 once without tools, then skips tools for that model", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(refuse()).mockImplementation(async () => ok())
    vi.stubGlobal("fetch", fetch)
    const p = provider("retry-a", "openai-chat")
    expect(await run(p, req("m"))).toContain("text")
    expect(toolsSent(fetch)).toEqual([1, 0])
    await run(p, req("m"))
    expect(toolsSent(fetch)).toEqual([1, 0, 0])
    await run(p, req("other"))
    expect(toolsSent(fetch)).toEqual([1, 0, 0, 1])
  })

  it("retries only once: a second 400 is the error", async () => {
    const fetch = vi.fn().mockImplementation(async () => refuse())
    vi.stubGlobal("fetch", fetch)
    const p = provider("retry-b", "openai-chat")
    await expect(run(p, req("m"))).rejects.toThrow(/HTTP 400/)
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(run(p, req("m"))).rejects.toThrow(/HTTP 400/)
    expect(toolsSent(fetch)).toEqual([1, 0, 1, 0])
  })

  it("does not retry other statuses or a request without tools", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("no", { status: 401 }))
    vi.stubGlobal("fetch", fetch)
    await expect(run(provider("retry-c", "openai-chat"), req("m"))).rejects.toThrow(/HTTP 401/)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockClear()
    fetch.mockImplementation(async () => refuse())
    await expect(run(provider("retry-c", "openai-chat"), { ...req("m"), tools: [] })).rejects.toThrow(/HTTP 400/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("covers the Responses protocol too", async () => {
    const done = () => new Response('data: {"type":"response.completed","response":{}}\n\n', { status: 200 })
    const fetch = vi.fn().mockResolvedValueOnce(refuse()).mockImplementation(async () => done())
    vi.stubGlobal("fetch", fetch)
    expect(await run(provider("retry-d", "openai"), req("m"))).toContain("done")
    expect(toolsSent(fetch)).toEqual([1, 0])
  })
})
