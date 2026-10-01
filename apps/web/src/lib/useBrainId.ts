"use client";

import { useLiveStore } from "@/lib/live/liveStore";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { brainIdOf } from "@/lib/telemetryIds";

/** The brain a new chat would talk to, as a closed id: the picked coding agent, else the API provider. */
export function useBrainId() {
  const agent = useLiveStore((s) => s.boundAgent);
  const { loading, providerId } = useApiModeChoice();
  return brainIdOf(agent ?? (loading ? undefined : providerId));
}
