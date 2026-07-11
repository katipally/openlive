/**
 * Canonical engine types shared by core, providers, tools, and the TUI.
 * These are wire-format-agnostic; each provider adapter converts to/from its own shape.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * The effort levels a model meaningfully supports, given its provider protocol. OpenAI's
 * `reasoning_effort` only accepts low/medium/high (xhigh/max collapse to high), while Anthropic and
 * Google take a thinking-token budget and honor all five. A non-reasoning model supports none.
 */
export function allowedEfforts(protocol?: Protocol, reasoning = true): readonly Effort[] {
  if (!reasoning) return []
  // Chat Completions providers are always-on-reasoning (no per-request effort knob).
  if (protocol === "openai-chat") return []
  if (protocol === "openai") return ["low", "medium", "high"]
  return EFFORTS
}

/** A pending or completed tool call as the model expressed it. */
export interface ToolCall {
  id: string
  name: string
  /** raw JSON string of arguments (may be partial while streaming) */
  arguments: string
}

/** An image attached to a user message (base64-encoded). */
export interface ImagePart {
  data: string
  mime: string
}

/** Canonical conversation message kept by the engine. */
export type Message =
  | { role: "system"; text: string }
  | { role: "user"; text: string; images?: ImagePart[] }
  | { role: "assistant"; text?: string; reasoning?: string; reasoningSignature?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; result: string; isError?: boolean; images?: ImagePart[] }

/** Tool description handed to the model (JSON-Schema parameters). */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

/** What a request to a provider needs. */
export interface ChatRequest {
  model: string
  messages: Message[]
  tools: ToolDef[]
  effort?: Effort
  /** Raw reasoning-effort override for the OpenAI Responses API (e.g. "minimal"
   *  for GPT-5, which the Effort enum doesn't expose). Takes precedence over
   *  `effort`; ignored by other providers. Used by live mode for lowest latency. */
  reasoningEffort?: string
  maxTokens?: number
}

/** Provider wire protocol — selects the adapter. Three adapters:
 *  - `anthropic`   → /messages (Claude + MiniMax's Anthropic-compat endpoint)
 *  - `openai`      → /responses (OpenAI Responses API + Ollama v0.13.3+)
 *  - `openai-chat` → /chat/completions (the universal dialect: Groq, Together,
 *                    Fireworks, OpenRouter, DeepSeek, Mistral, xAI, Cerebras, …) */
export type Protocol = "openai" | "openai-chat" | "anthropic"

/** Per-provider deviations from the canonical wire format of its protocol.
 *  MiniMax speaks the Anthropic protocol but doesn't accept `cache_control`
 *  blocks or Anthropic's adaptive-thinking params, and authenticates with a
 *  Bearer token rather than `x-api-key`. */
export interface ProviderQuirks {
  /** don't send Anthropic `cache_control` blocks (provider does its own prefix caching) */
  noCacheControl?: boolean
  /** don't send `thinking`/`output_config` params (provider's reasoning is always-on or off) */
  noThinking?: boolean
  /** also send `Authorization: Bearer <key>` (Anthropic-compat providers that want it) */
  bearerAuth?: boolean
}

/** A configured provider the user can connect to. */
export interface ProviderInfo {
  id: string
  name: string
  protocol: Protocol
  baseURL: string
  /** env vars to auto-detect a key from, if present */
  envKeys?: string[]
  /** true for OpenAI-compatible local servers (ollama/llama.cpp) that need no key */
  keyless?: boolean
  /** wire-format deviations from the protocol's canonical shape */
  quirks?: ProviderQuirks
  /** user added this as a custom endpoint */
  custom?: boolean
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  contextWindow?: number
  maxOutput?: number
  /** model exposes a reasoning/thinking channel */
  reasoning?: boolean
  /** accepts image input (real capability from models.dev modalities / provider payload; undefined = unknown) */
  vision?: boolean
  /** USD per 1M tokens, when known */
  cost?: { input: number; output: number }
  /** true when surfaced from the provider's own live endpoint (vs offline snapshot) */
  live?: boolean
}

/** Normalized streaming event emitted by every provider adapter. */
export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  /** the signed reasoning block (Anthropic) — must be replayed on later turns when tools are used */
  | { type: "reasoning_signature"; signature: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; argsDelta: string }
  | { type: "tool_stop"; index: number }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; stopReason: string }
