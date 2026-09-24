import {
  listProviders, createProvider, updateProvider,
  getProviderApiKey, getSetting, setSetting, getAllSettings,
} from "@openlive/db";
import {
  BUILTIN_PROVIDERS, envKeyFor, isReasoningModel, resolveApiMode, withSettings,
  type ChatRequest, type ProviderInfo, type Effort,
} from "@openlive/harness";

// Provider-neutral resolution. Keys live in the DB `providers` table (kind =
// harness provider id) or fall back to the provider's declared env vars.

export function providerInfo(id: string): ProviderInfo | undefined {
  const p = BUILTIN_PROVIDERS.find((b) => b.id === id);
  return p && withSettings(p, { ollamaBaseUrl: getSetting("ollamaBaseUrl") });
}

// Seed a DB provider row for every builtin whose env key is present, so a host
// that DID set an env key is usable without opening Settings. Keys are normally
// entered in the UI; this is just a convenience fallback. First one becomes default.
export async function ensureSeedProviders(): Promise<void> {
  const existing = listProviders();
  let seededDefault = existing.some((p) => p.isDefault);
  for (const p of BUILTIN_PROVIDERS) {
    const envKey = p.envKeys?.map((k) => process.env[k]?.trim()).find(Boolean) || null;
    if (!envKey) continue;
    const row = existing.find((e) => e.kind === p.id);
    if (!row) {
      await createProvider({ name: p.name, kind: p.id, apiKey: envKey, isDefault: !seededDefault });
      seededDefault = true;
    } else if (!row.hasKey) {
      await updateProvider(row.id, { apiKey: envKey });
    }
  }
}

// Decrypted key for a provider id: DB row first, then the provider's env vars.
export function getProviderKey(providerId: string): string | null {
  const row = listProviders().find((p) => p.kind === providerId);
  const dbKey = row ? getProviderApiKey(row.id) : null;
  if (dbKey) return dbKey;
  const info = providerInfo(providerId);
  return info?.envKeys?.map((k) => process.env[k]?.trim()).find(Boolean) || null;
}

export interface ResolvedLive {
  provider: ProviderInfo;
  model: string;
  apiKey: string | null;
  /** User's effort override, or undefined = auto (lowest, for smoothest voice). */
  effort?: Effort;
}

// Optional dedicated vision model (its own provider), used to SEE for a live
// model that can't. Null unless the user configured one AND it's usable.
export function resolveVision(): ResolvedLive | null {
  const providerId = getSetting("visionProviderId");
  const model = getSetting("visionModel");
  if (!providerId || !model) return null;
  const provider = providerInfo(providerId);
  if (!provider) return null;
  const apiKey = getProviderKey(providerId);
  if (!apiKey && !provider.keyless) return null;
  return { provider, model, apiKey };
}

/**
 * How hard a spoken turn thinks, in the form its provider accepts. Auto is
 * thinking off: OpenAI cannot switch it off, so it gets "minimal", and Anthropic
 * simply gets no thinking block. A model with no reasoning channel gets nothing,
 * because OpenAI and Ollama both reject a reasoning setting on one.
 */
export function liveReasoning({ provider, model, effort }: ResolvedLive): Pick<ChatRequest, "effort" | "reasoningEffort"> {
  if (!isReasoningModel(model)) return {};
  if (provider.protocol === "openai") return { reasoningEffort: effort ?? "minimal" };
  return effort ? { effort } : {};
}

/** API mode as the whole app resolves it: the provider the person chose, even
 *  one that cannot run yet, so the turn fails naming the fix instead of quietly
 *  answering from a provider they never picked. */
export function resolveLive(): ResolvedLive {
  const { provider, model, effort } = resolveApiMode(getAllSettings(), listProviders(), (p) => !!envKeyFor(p));
  return { provider, model, apiKey: getProviderKey(provider.id), effort };
}
