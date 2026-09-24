"use client";

import { useQuery } from "@tanstack/react-query";
// Pure subpath only: the barrel pulls in catalog/models (node:fs).
import { resolveApiMode } from "@openlive/harness/registry";
import { api } from "@/lib/api";

/** The one API-mode pick Chat and Flow share, set in Settings > Models, resolved
 *  by the same function the agent service runs a turn with. An unpicked model is
 *  shown as the one that would run, not as blank. */
export function useApiModeChoice() {
  const { data: providers = [], isLoading: providersLoading } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { provider, model, ready } = resolveApiMode(settings ?? {}, providers);
  return {
    loading: isLoading || providersLoading,
    providerId: provider.id,
    providerName: provider.name,
    model,
    effort: settings?.liveEffort || "auto",
    usable: ready,
  };
}
