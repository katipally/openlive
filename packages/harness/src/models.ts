import type { ModelInfo, ProviderInfo } from "./types"
import { catalogModels, getModels } from "./catalog"
import { isReasoningModel } from "./effort"

const NON_CHAT =
  /(embedding|embed|whisper|tts|text-to-speech|\baudio\b|speech|dall-?e|\bimage\b|moderation|rerank|guard|stable-diffusion|\bsora\b|realtime|transcribe|\bclip\b|reranker)/i

const TIMEOUT = 8000

interface LiveModel {
  id: string
  name?: string
  raw: any
}

async function fetchOpenAICompat(baseURL: string, apiKey?: string): Promise<LiveModel[]> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json: any = await res.json()
  const data: any[] = json.data ?? json.models ?? []
  return data.map((m) => ({ id: m.id ?? m.name, name: m.name, raw: m })).filter((m) => m.id)
}

async function fetchAnthropic(baseURL: string, apiKey?: string): Promise<LiveModel[]> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models?limit=1000`, {
    headers: { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json: any = await res.json()
  return (json.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name, raw: m }))
}

function costFrom(meta: any, raw: any): { input: number; output: number } | undefined {
  if (meta?.cost && (meta.cost.input != null || meta.cost.output != null)) {
    return { input: meta.cost.input ?? 0, output: meta.cost.output ?? 0 }
  }
  // OpenRouter exposes per-token pricing as strings
  if (raw?.pricing && (raw.pricing.prompt != null || raw.pricing.completion != null)) {
    const input = parseFloat(raw.pricing.prompt) * 1e6
    const output = parseFloat(raw.pricing.completion) * 1e6
    if (!Number.isNaN(input) || !Number.isNaN(output)) return { input: input || 0, output: output || 0 }
  }
  return undefined
}

function isChat(id: string, meta: any): boolean {
  if (NON_CHAT.test(id)) return false
  const out = meta?.modalities?.output
  if (Array.isArray(out) && out.length && !out.includes("text")) return false
  return true
}

function enrich(l: LiveModel, meta: any, providerId: string): ModelInfo {
  return {
    id: l.id,
    name: meta?.name ?? l.name ?? l.id,
    providerId,
    contextWindow: meta?.limit?.context ?? l.raw?.context_length ?? l.raw?.inputTokenLimit,
    maxOutput: meta?.limit?.output ?? l.raw?.outputTokenLimit,
    reasoning: meta?.reasoning ?? isReasoningModel(l.id),
    // Real image-input capability: models.dev modalities, else the provider's own
    // payload (OpenRouter ships `architecture.input_modalities`). undefined = unknown.
    vision:
      meta?.modalities?.input?.includes("image") ??
      (l.raw?.architecture?.input_modalities?.includes?.("image") || undefined),
    cost: costFrom(meta, l.raw),
    live: true,
  }
}

/**
 * Live model list for a provider, enriched with models.dev metadata. Falls back to the models.dev
 * catalog, then the offline snapshot, if the live endpoint is unavailable.
 */
export async function fetchModels(provider: ProviderInfo, apiKey?: string): Promise<ModelInfo[]> {
  const catalogId = (provider as any).catalogId as string | undefined
  let live: LiveModel[] = []
  try {
    if (provider.protocol === "anthropic") live = await fetchAnthropic(provider.baseURL, apiKey)
    else live = await fetchOpenAICompat(provider.baseURL, apiKey)
  } catch {
    // fall through to catalog/snapshot
  }

  if (!live.length) return (await getModels(provider.id, catalogId)).filter((m) => isChat(m.id, undefined))

  const meta = await catalogModels(catalogId)
  return live
    .map((l) => enrich(l, meta[l.id], provider.id))
    .filter((m) => isChat(m.id, meta[m.id]))
    .sort((a, b) => a.name.localeCompare(b.name))
}
