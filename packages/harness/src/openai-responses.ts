import type { ChatRequest, Message, ProviderEvent, ToolDef } from "./types"
import { EFFORT_MAP } from "./effort"
import { fetchWithRetry } from "./retry"
import { sseLines } from "./sse"

/** Convert canonical messages to the Responses API: top-level `instructions` + typed `input` items. */
function toResponsesInput(messages: Message[]): { instructions?: string; input: unknown[] } {
  let instructions: string | undefined
  const input: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === "system") {
      instructions = instructions ? `${instructions}\n\n${m.text}` : m.text
    } else if (m.role === "user") {
      if (m.images?.length) {
        const content: Record<string, unknown>[] = []
        if (m.text) content.push({ type: "input_text", text: m.text })
        for (const img of m.images)
          content.push({ type: "input_image", image_url: `data:${img.mime};base64,${img.data}` })
        input.push({ role: "user", content })
      } else input.push({ role: "user", content: m.text })
    } else if (m.role === "assistant") {
      if (m.text) input.push({ role: "assistant", content: m.text })
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments || "{}" })
      }
    } else if (m.role === "tool") {
      // A string when there is nothing to see: Ollama took only strings here
      // before its April 2026 release, and a text result is most of them.
      const output = m.images?.length
        ? [
            { type: "input_text", text: m.result },
            ...m.images.map((img) => ({ type: "input_image", image_url: `data:${img.mime};base64,${img.data}` })),
          ]
        : m.result
      input.push({ type: "function_call_output", call_id: m.callId, output })
    }
  }
  return { instructions, input }
}

function toTools(tools: ToolDef[]): unknown[] {
  // Responses uses flattened function tools: { type, name, description, parameters }
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }))
}

export async function* streamOpenAIResponses(opts: {
  baseURL: string
  apiKey?: string
  req: ChatRequest
  signal: AbortSignal
  headers?: Record<string, string>
}): AsyncGenerator<ProviderEvent> {
  const { baseURL, apiKey, req, signal } = opts
  const { instructions, input } = toResponsesInput(req.messages)
  const body: Record<string, unknown> = {
    model: req.model,
    input,
    stream: true,
    store: false, // we manage history ourselves
  }
  if (instructions) body.instructions = instructions
  if (req.tools.length) body.tools = toTools(req.tools)
  // reasoningEffort is a raw passthrough (e.g. "minimal" on GPT-5) and wins over
  // the mapped Effort; skip the summary for minimal to shave latency + tokens.
  if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort }
  else if (req.effort) body.reasoning = { effort: EFFORT_MAP[req.effort], summary: "auto" }
  if (req.maxTokens) body.max_output_tokens = req.maxTokens

  const res = await fetchWithRetry(
    `${baseURL.replace(/\/$/, "")}/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal,
    },
    signal,
  )
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`)
  }

  // map streaming function_call item ids -> our normalized tool index
  const callByItem = new Map<string, number>()
  let toolIndex = 0

  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    let ev: any
    try {
      ev = JSON.parse(payload)
    } catch {
      continue
    }
    switch (ev.type) {
      case "response.output_text.delta":
        if (ev.delta) yield { type: "text", delta: ev.delta }
        break
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (ev.delta) yield { type: "reasoning", delta: ev.delta }
        break
      case "response.output_item.added": {
        const item = ev.item
        if (item?.type === "function_call") {
          const index = toolIndex++
          callByItem.set(item.id, index)
          yield { type: "tool_start", index, id: item.call_id ?? item.id, name: item.name ?? "" }
        }
        break
      }
      case "response.function_call_arguments.delta": {
        const index = callByItem.get(ev.item_id)
        if (index != null && ev.delta) yield { type: "tool_delta", index, argsDelta: ev.delta }
        break
      }
      case "response.function_call_arguments.done": {
        const index = callByItem.get(ev.item_id)
        if (index != null) yield { type: "tool_stop", index }
        break
      }
      case "response.completed":
      case "response.incomplete": {
        const usage = ev.response?.usage
        if (usage) yield { type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
        yield { type: "done", stopReason: "stop" }
        return
      }
      case "response.failed":
      case "error":
        // The failure message can arrive as response.error, a top-level `error`
        // object (the `{type:"error", error:{…}}` shape), or a bare `message`.
        throw new Error(ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? "Responses API error")
    }
  }
  yield { type: "done", stopReason: "stop" }
}
