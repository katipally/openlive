import type { ChatRequest, Message, ProviderEvent, ToolDef } from "./types"
import { fetchWithRetry } from "./retry"
import { sseLines } from "./sse"

/** The OpenAI Chat Completions wire (`/chat/completions`) — the near-universal
 *  dialect. Groq, Together, Fireworks, OpenRouter, DeepSeek, Mistral, xAI, and
 *  most other hosted providers speak it (OpenAI's own Responses API and Ollama
 *  are handled by the `openai` adapter instead). */

function toChatMessages(messages: Message[]): unknown[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.text })
    } else if (m.role === "user") {
      if (m.images?.length) {
        const content: Record<string, unknown>[] = []
        if (m.text) content.push({ type: "text", text: m.text })
        for (const img of m.images)
          content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })
        out.push({ role: "user", content })
      } else out.push({ role: "user", content: m.text })
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.text ?? "" }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        }))
      }
      out.push(msg)
    } else if (m.role === "tool") {
      // ponytail: the tool role is text-only across Chat Completions providers —
      // tool-result images (computer-use screenshots) are dropped here. Use an
      // `anthropic`/Responses provider if you need vision-in-tool-results.
      out.push({ role: "tool", tool_call_id: m.callId, content: m.result })
    }
  }
  return out
}

function toTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export async function* streamOpenAIChat(opts: {
  baseURL: string
  apiKey?: string
  req: ChatRequest
  signal: AbortSignal
  headers?: Record<string, string>
}): AsyncGenerator<ProviderEvent> {
  const { baseURL, apiKey, req, signal } = opts
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toChatMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.tools.length) body.tools = toTools(req.tools)
  // Raw passthrough only. Most Chat Completions providers reject an unknown
  // `reasoning_effort`, and reasoning models here are always-on (they emit
  // reasoning_content regardless), so we don't send the mapped Effort.
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
  if (req.maxTokens) body.max_tokens = req.maxTokens

  const res = await fetchWithRetry(
    `${baseURL.replace(/\/$/, "")}/chat/completions`,
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

  const seen = new Set<number>() // tool-call indexes we've already tool_start'ed
  let stopReason = "stop"

  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") break
    let ev: any
    try {
      ev = JSON.parse(payload)
    } catch {
      continue
    }
    // Usage arrives on a trailing chunk (choices often empty) when include_usage is set.
    if (ev.usage) yield { type: "usage", input: ev.usage.prompt_tokens ?? 0, output: ev.usage.completion_tokens ?? 0 }

    const choice = ev.choices?.[0]
    if (!choice) continue
    const d = choice.delta
    if (d?.content) yield { type: "text", delta: d.content }
    // reasoning_content (DeepSeek), reasoning (OpenRouter/others)
    const rc = d?.reasoning_content ?? d?.reasoning
    if (rc) yield { type: "reasoning", delta: rc }
    for (const tc of d?.tool_calls ?? []) {
      const index = tc.index ?? 0
      if (!seen.has(index)) {
        seen.add(index)
        yield { type: "tool_start", index, id: tc.id ?? `call_${index}`, name: tc.function?.name ?? "" }
      }
      if (tc.function?.arguments) yield { type: "tool_delta", index, argsDelta: tc.function.arguments }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason
  }

  for (const index of seen) yield { type: "tool_stop", index }
  yield { type: "done", stopReason }
}
