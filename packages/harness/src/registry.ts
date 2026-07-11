import type { ProviderInfo } from "./types"

/**
 * The three supported providers. Claude and MiniMax both speak the Anthropic
 * wire protocol (MiniMax via its Anthropic-compat endpoint, with quirks);
 * OpenAI speaks the Responses API. `catalogId` maps to the models.dev key.
 */
export interface BuiltinProvider extends ProviderInfo {
  catalogId?: string
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    catalogId: "anthropic",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseURL: "https://api.openai.com/v1",
    envKeys: ["OPENAI_API_KEY"],
    catalogId: "openai",
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "anthropic",
    // Anthropic-compatible endpoint (full path .../anthropic/v1; the adapter
    // appends /messages). MiniMax authenticates with a Bearer token and does
    // NOT accept cache_control blocks or Anthropic's adaptive-thinking params
    // (its M2.x reasoning is always-on) — hence the quirks. It does its own
    // automatic prefix caching, so caching isn't lost.
    baseURL: "https://api.minimax.io/anthropic/v1",
    envKeys: ["MINIMAX_API_KEY"],
    catalogId: "minimax",
    quirks: { noCacheControl: true, noThinking: true, bearerAuth: true },
  },
  {
    // Local Ollama. Speaks the OpenAI Responses API (/v1/responses, Ollama
    // v0.13.3+), so the existing "openai" adapter works unchanged. Keyless — the
    // OpenAI SDK requires a token but Ollama ignores it locally. Models come live
    // from /v1/models (whatever you've `ollama pull`ed).
    id: "ollama",
    name: "Ollama (local)",
    protocol: "openai",
    baseURL: "http://localhost:11434/v1",
    keyless: true,
  },
  {
    // Ollama Cloud — same wire, hosted. Needs a real key (ollama.com/settings/keys),
    // sent as Bearer by the openai adapter.
    id: "ollama-cloud",
    name: "Ollama Cloud",
    protocol: "openai",
    baseURL: "https://ollama.com/v1",
    envKeys: ["OLLAMA_API_KEY"],
  },
  // --- Chat Completions providers (the universal /chat/completions dialect) ---
  // All Bearer-auth, all list models live from /v1/models (except Perplexity,
  // which has no /models — its snapshot below is the source of truth).
  {
    id: "groq",
    name: "Groq",
    protocol: "openai-chat",
    baseURL: "https://api.groq.com/openai/v1",
    envKeys: ["GROQ_API_KEY"],
    catalogId: "groq",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    baseURL: "https://openrouter.ai/api/v1",
    envKeys: ["OPENROUTER_API_KEY"],
    catalogId: "openrouter",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY"],
    catalogId: "deepseek",
  },
  {
    id: "mistral",
    name: "Mistral",
    protocol: "openai-chat",
    baseURL: "https://api.mistral.ai/v1",
    envKeys: ["MISTRAL_API_KEY"],
    catalogId: "mistral",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    protocol: "openai-chat",
    baseURL: "https://api.x.ai/v1",
    envKeys: ["XAI_API_KEY"],
    catalogId: "xai",
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "openai-chat",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    catalogId: "google",
  },
  {
    id: "together",
    name: "Together",
    protocol: "openai-chat",
    baseURL: "https://api.together.xyz/v1",
    envKeys: ["TOGETHER_API_KEY"],
    catalogId: "togetherai",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    protocol: "openai-chat",
    baseURL: "https://api.fireworks.ai/inference/v1",
    envKeys: ["FIREWORKS_API_KEY"],
    catalogId: "fireworks-ai",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-chat",
    baseURL: "https://api.cerebras.ai/v1",
    envKeys: ["CEREBRAS_API_KEY"],
    catalogId: "cerebras",
  },
  {
    // No /models endpoint — snapshot is the picker's only source.
    id: "perplexity",
    name: "Perplexity",
    protocol: "openai-chat",
    baseURL: "https://api.perplexity.ai",
    envKeys: ["PERPLEXITY_API_KEY"],
    catalogId: "perplexity",
  },
]

/** A sane default model id for a provider when the user hasn't picked one — the
 *  first snapshot entry (curated "good default" per provider). Keeps the promise
 *  that adding any single key and chatting Just Works with no model pick; without
 *  it the model id is "" and every provider 400s. */
export function defaultModel(providerId: string): string {
  return MODEL_SNAPSHOT[providerId]?.[0] ?? ""
}

/** Small offline snapshot so the /model picker always has options (overridden by models.dev). */
export const MODEL_SNAPSHOT: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  openai: ["gpt-5", "gpt-5-mini", "o3"],
  // MiniMax-M3 (1M ctx, vision) and M2.5 (vision) support images over the
  // Anthropic-compat endpoint; M2 is text-only.
  minimax: ["MiniMax-M3", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  // ponytail: guesses so the picker has a default before /v1/models loads. Local
  // depends on what you've pulled; cloud ids carry the `-cloud` suffix. Live fetch
  // corrects both the moment the server/key is reachable.
  ollama: ["llama3.2", "qwen3", "gemma3"],
  "ollama-cloud": ["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "deepseek-v3.1:671b-cloud"],
  // ponytail: one sane default each so chat works pre-live-fetch; the picker
  // fills the real list from /v1/models. Ids drift — treat as seeds, not truth.
  // Verified current against models.dev on 2026-07-11; first entry is the
  // zero-click default (prefer fast + vision for voice+camera).
  groq: ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile"],
  openrouter: ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"], // -chat/-reasoner deprecated 2026-07-24
  mistral: ["mistral-large-latest", "mistral-small-latest"],
  xai: ["grok-4.5", "grok-4.3"], // grok-4 deprecated 2026-05-15
  google: ["gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-pro"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
  fireworks: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/deepseek-v3"],
  cerebras: ["gemma-4-31b", "zai-glm-4.7", "gpt-oss-120b"],
  perplexity: ["sonar", "sonar-pro", "sonar-reasoning"],
}
