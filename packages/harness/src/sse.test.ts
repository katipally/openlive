import { describe, expect, it } from "vitest"
import { sseLines } from "./sse"

const enc = new TextEncoder()

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const line of sseLines(body)) out.push(line)
  return out
}

// ~8.4MB of short lines, past the 8M single-line limit.
const lines = Array.from({ length: 420_000 }, (_, i) => `data: {"n":${i}}`)
const payload = lines.join("\n\n") + "\n\n"

describe("sseLines", () => {
  it("parses one chunk bigger than the line limit when it holds many short lines", async () => {
    expect(payload.length).toBeGreaterThan(8_000_000)
    expect(await collect(streamOf(payload, payload.length))).toEqual(lines)
  })

  it("parses the same payload identically in small chunks", async () => {
    expect(await collect(streamOf(payload, 1000))).toEqual(lines)
  })

  it("rejects a single line over the limit with no newline", async () => {
    await expect(collect(streamOf("x".repeat(8_000_001), 1_000_000))).rejects.toThrow(/size limit/)
  })

  it("strips CRLF and joins lines split across chunks", async () => {
    expect(await collect(streamOf("data: a\r\ndata: b\r\n\r\ndata: c", 3))).toEqual(["data: a", "data: b", "data: c"])
  })
})
