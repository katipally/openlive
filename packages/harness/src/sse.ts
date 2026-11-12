/** Guard against a pathological response with no newline growing the buffer unbounded (OOM). */
const MAX_SSE_LINE = 8_000_000

/** Yield SSE lines from a fetch response body (handles chunk boundaries). */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let start = 0
      let idx: number
      while ((idx = buffer.indexOf("\n", start)) >= 0) {
        const line = buffer.slice(start, idx).replace(/\r$/, "")
        start = idx + 1
        if (line) yield line
      }
      buffer = buffer.slice(start)
      if (buffer.length > MAX_SSE_LINE) throw new Error("SSE line exceeded the size limit")
    }
    const tail = buffer.trim()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

export function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
