import {
  listProviders, createProvider, updateProvider,
  getProviderApiKey, getSetting, setSetting,
} from "@openlive/db";
import { BUILTIN_PROVIDERS, defaultModel, type ProviderInfo, type Effort } from "@openlive/harness";
import { liveRecsFor } from "@openlive/shared";

// Provider-neutral resolution. Keys live in the DB `providers` table (kind =
// harness provider id) or fall back to the provider's declared env vars.

export function providerInfo(id: string): ProviderInfo | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}

// Seed a DB provider row for every builtin whose env key is present, so a host
// that DID set an env key is usable without opening Settings. Keys are normally
// entered in the UI; this is just a convenience fallback. First one becomes default.
export function ensureSeedProviders() {
  const existing = listProviders();
  let seededDefault = existing.some((p) => p.isDefault);
  for (const p of BUILTIN_PROVIDERS) {
    const envKey = p.envKeys?.map((k) => process.env[k]?.trim()).find(Boolean) || null;
    if (!envKey) continue;
    const row = existing.find((e) => e.kind === p.id);
    if (!row) {
      createProvider({ name: p.name, kind: p.id, apiKey: envKey, isDefault: !seededDefault });
      seededDefault = true;
    } else if (!row.hasKey) {
      updateProvider(row.id, { apiKey: envKey });
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

// Which provider powers LIVE voice. The `liveProviderId` setting if it's keyed;
// else camera-first — prefer a keyed provider whose fast live model can SEE.
function liveProviderId(): string {
  const explicit = getSetting("liveProviderId");
  if (explicit && providerInfo(explicit) && getProviderKey(explicit)) return explicit;
  for (const id of ["anthropic", "openai", "minimax"]) {
    if (!getProviderKey(id)) continue;
    const rec = liveRecsFor(id).find((r) => r.default) ?? liveRecsFor(id)[0];
    if (rec?.vision) return id;
  }
  // No vision provider keyed → first keyed provider at all.
  const anyKeyed = BUILTIN_PROVIDERS.find((p) => getProviderKey(p.id));
  return anyKeyed?.id ?? BUILTIN_PROVIDERS[0]!.id;
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

export function resolveLive(): ResolvedLive {
  const providerId = liveProviderId();
  const provider = providerInfo(providerId) ?? BUILTIN_PROVIDERS[0]!;
  const recs = liveRecsFor(provider.id);
  const rec = recs.find((r) => r.default) ?? recs[0];
  const explicitProvider = getSetting("liveProviderId");
  const liveModel = getSetting("liveModel");
  const model = (explicitProvider === providerId && liveModel) ? liveModel : (rec?.model || defaultModel(provider.id));
  // Effort default is lowest (auto → undefined here; turn-runner picks lowest).
  // A user override in Settings raises it for depth over latency.
  const eff = getSetting("liveEffort");
  const effort = eff && eff !== "none" && eff !== "auto" ? (eff as Effort) : undefined;
  return { provider, model, apiKey: getProviderKey(provider.id), effort };
}
