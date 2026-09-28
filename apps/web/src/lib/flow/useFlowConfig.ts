"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FlowConfig } from "@openlive/flow-store";
import { loadPipelineConfig } from "@/lib/live/pipelineConfig";
import { flowBridge } from "./bridge";
import { settleTurnOverride } from "./wait";

// Flow's settings, as every Flow screen reads and writes them. One query key, so
// a switch flipped on one screen is already true on the next.

export interface FlowConfigReply { config: FlowConfig; brainReady: boolean }

/** A partial edit. Sections merge, so a screen sends only what it owns. */
export type FlowConfigPatch = {
  [K in keyof FlowConfig]?: FlowConfig[K] extends object ? Partial<FlowConfig[K]> : FlowConfig[K];
};

const KEY = ["flow-config"];
let settling = false;

const read = async (): Promise<FlowConfigReply> => {
  const r = await fetch("/api/flow/config", { cache: "no-store" });
  if (!r.ok) throw new Error("Flow settings could not be read.");
  return r.json() as Promise<FlowConfigReply>;
};

export function useFlowConfig() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: read, staleTime: 5_000 });
  const mutation = useMutation({
    mutationFn: async ({ patch, settle }: { patch: FlowConfigPatch; settle?: boolean }): Promise<FlowConfigReply> => {
      const r = await fetch(settle ? "/api/flow/config?settle=1" : "/api/flow/config", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error("That setting could not be saved.");
      return r.json() as Promise<FlowConfigReply>;
    },
    // The server's parse is the authority: it clamps, defaults and refuses, so
    // the screen shows what was actually written rather than what was asked for.
    onSuccess: (reply) => {
      qc.setQueryData(KEY, reply);
      // The runtime lives in another renderer and reads this file itself. Telling
      // it is what makes a rebind, a new hold threshold or a changed quiet rule
      // take effect now rather than at the next launch.
      flowBridge()?.settingsChanged?.();
    },
  });

  // A config from before the wait was shared has its override undecided, and
  // only this renderer holds Chat's wait to compare it with. Every screen using
  // this hook sees the same config, so one write goes; the server applies it only
  // while still undecided, so it can never undo a choice made meanwhile.
  const config = query.data?.config;
  const { mutateAsync } = mutation;
  useEffect(() => {
    const on = config && settleTurnOverride(config, loadPipelineConfig());
    if (on == null || settling) return;
    settling = true;
    mutateAsync({ patch: { voice: { turnOverride: on } }, settle: true }).catch(() => {}).finally(() => { settling = false; });
  }, [config, mutateAsync]);

  return {
    config: query.data?.config ?? null,
    brainReady: query.data?.brainReady ?? false,
    loading: query.isLoading,
    error: query.error ? String((query.error as Error).message) : mutation.error ? String((mutation.error as Error).message) : "",
    saving: mutation.isPending,
    save: (patch: FlowConfigPatch) => mutation.mutate({ patch }),
    refetch: () => void qc.invalidateQueries({ queryKey: KEY }),
  };
}
