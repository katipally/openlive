import type { ChatRequest, ProviderEvent, ProviderInfo } from "./types"
import { streamAnthropic } from "./anthropic"
import { streamOpenAIResponses } from "./openai-responses"
import { streamOpenAIChat } from "./openai-chat"

export * from "./types"
export * from "./effort"
export * from "./catalog"
export * from "./models"
export * from "./registry"

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
  if (provider.protocol === "openai-chat")
    return streamOpenAIChat({ baseURL: provider.baseURL, apiKey, req, signal })
  return streamOpenAIResponses({ baseURL: provider.baseURL, apiKey, req, signal })
}
