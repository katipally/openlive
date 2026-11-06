import type { ChatRequest, ProviderEvent, ProviderInfo } from "./types"
import { streamAnthropic } from "./anthropic"
import { streamOpenAIResponses } from "./openai-responses"
import { streamOpenAIChat } from "./openai-chat"

export * from "./types"
export * from "./effort"
export * from "./catalog"
export * from "./models"
export * from "./registry"

/** Models that refused a request carrying tools and answered the same one without, so later turns skip tools. */
const noTools = new Set<string>()

const refusedAsBadRequest = (e: unknown) => e instanceof Error && /^HTTP 400\b/.test(e.message)

/** Dispatch a streaming chat request to the right wire adapter: Anthropic
 *  (/messages), OpenAI Responses (/responses), or OpenAI Chat (/chat/completions). */
export function streamProvider(
  provider: ProviderInfo,
  apiKey: string | undefined,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  if (provider.protocol === "anthropic")
    return streamAnthropic({ baseURL: provider.baseURL, apiKey, req, signal, quirks: provider.quirks })
  return streamOpenAICompatible(provider, apiKey, req, signal)
}

/** A server that cannot take tools (an Ollama model without them answers 400) still answers the turn: the
 *  request is retried once without them, before anything has streamed, and the model is remembered for the session. */
async function* streamOpenAICompatible(
  provider: ProviderInfo,
  apiKey: string | undefined,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const stream = (r: ChatRequest) =>
    provider.protocol === "openai-chat"
      ? streamOpenAIChat({ baseURL: provider.baseURL, apiKey, req: r, signal })
      : streamOpenAIResponses({ baseURL: provider.baseURL, apiKey, req: r, signal })
  const key = `${provider.baseURL}|${req.model}`
  const bare: ChatRequest = { ...req, tools: [], toolChoice: undefined }
  if (!req.tools.length || noTools.has(key)) return yield* stream(bare)
  let started = false
  try {
    for await (const ev of stream(req)) {
      started = true
      yield ev
    }
  } catch (e) {
    if (started || !refusedAsBadRequest(e)) throw e
    yield* stream(bare)
    noTools.add(key)
  }
}

