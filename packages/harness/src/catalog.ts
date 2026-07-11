import fs from "node:fs"
import path from "node:path"
import type { ModelInfo } from "./types"
import { cacheDir } from "./paths"
import { MODEL_SNAPSHOT } from "./registry"

const TTL = 24 * 60 * 60 * 1000
const cachePath = () => path.join(cacheDir(), "models.json")

let memo: Record<string, any> | null = null

async function loadCatalog(): Promise<Record<string, any> | null> {
  if (memo) return memo
  // fresh cache
  try {
    const stat = fs.statSync(cachePath())
    if (Date.now() - stat.mtimeMs < TTL) {
      memo = JSON.parse(fs.readFileSync(cachePath(), "utf8"))
      return memo
    }
  } catch {
    /* no cache */
  }
  // network
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(12000) })
    if (res.ok) {
      const json = (await res.json()) as Record<string, any>
      fs.mkdirSync(cacheDir(), { recursive: true })
      fs.writeFileSync(cachePath(), JSON.stringify(json))
      memo = json
      return memo
    }
  } catch {
    /* offline */
  }
  // stale cache
  try {
    memo = JSON.parse(fs.readFileSync(cachePath(), "utf8"))
    return memo
  } catch {
    return null
  }
}

function snapshot(providerId: string): ModelInfo[] {
  return (MODEL_SNAPSHOT[providerId] ?? []).map((id) => ({ id, name: id, providerId }))
}

/** Raw models.dev metadata map ({ modelId -> meta }) for a provider, used to enrich live ids. */
export async function catalogModels(catalogId?: string): Promise<Record<string, any>> {
  if (!catalogId) return {}
  const cat = await loadCatalog()
  return cat?.[catalogId]?.models ?? {}
}

/** Models for a provider, from models.dev when available, else the offline snapshot. */
export async function getModels(providerId: string, catalogId?: string): Promise<ModelInfo[]> {
  // Providers without a catalog id (local/keyless) skip the network entirely.
  if (!catalogId) return snapshot(providerId)
  const cat = await loadCatalog()
  const out: ModelInfo[] = []
  const entry = cat ? cat[catalogId] : undefined
  if (entry?.models) {
    for (const key of Object.keys(entry.models)) {
      const m = entry.models[key]
      out.push({
        id: m.id ?? key,
        name: m.name ?? m.id ?? key,
        providerId,
        contextWindow: m.limit?.context ?? m.context_length,
        reasoning: !!m.reasoning,
        vision: m.modalities?.input?.includes("image") || undefined,
      })
    }
  }
  if (out.length) return out.sort((a, b) => a.name.localeCompare(b.name))
  return snapshot(providerId)
}
