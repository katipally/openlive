"use client";

import { useQuery } from "@tanstack/react-query";
// Pure subpath only: the barrel pulls in catalog/models (node:fs).
import { BUILTIN_PROVIDERS, defaultModel } from "@openlive/harness/registry";
import { liveRecsFor } from "@openlive/shared";
import { api } from "@/lib/api";

/** The one API-mode pick Chat and Flow share, set in Settings > Models. The
 *  provider falls back as the Models tab does; an unpicked model is shown as the
 *  one the agent service would run, not as blank. */
export function useApiModeChoice() {
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const providerId = settings?.liveProviderId ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? BUILTIN_PROVIDERS[0]!.id;
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  const recs = liveRecsFor(providerId);
  const model = settings?.liveModel || (recs.find((r) => r.default) ?? recs[0])?.model || defaultModel(providerId);
  const usable = !!provider && (!!provider.keyless || providers.some((p) => p.kind === providerId && p.hasKey));
  return { loading: isLoading, providerName: provider?.name ?? providerId, model, effort: settings?.liveEffort || "auto", usable };
}
