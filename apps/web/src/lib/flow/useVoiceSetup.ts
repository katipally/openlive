"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { FlowConfig } from "@openlive/flow-store";
import { log } from "../log";
import { useVoicePrefs } from "../prefs";
import { useLiveStore } from "../live/liveStore";
import { loadModels, modelsCached, modelsCachedSettled, voiceDownloadPlan } from "../live/models";
import { loadPipelineConfig, withSurfaceVoice, type PipelineConfig } from "../live/pipelineConfig";
import { voiceModels } from "../live/weights";
import { flowBridge } from "./bridge";
import { voiceSetupStep } from "./setup";
import { surfaceVoice } from "./voice";

// Flow's voice models, offered where Flow is set up instead of at the first
// summon. The download is the module's, not the screen's: it carries on when
// onboarding is left for Flow's home, and both read the same progress.

const useDownload = create<{ state: "idle" | "downloading" | "failed"; pct: number }>(() => ({ state: "idle", pct: 0 }));

async function download(cfg: PipelineConfig, voice: boolean, qc: QueryClient) {
  if (useDownload.getState().state === "downloading") return;
  useDownload.setState({ state: "downloading", pct: 0 });
  try {
    await loadModels((p) => useDownload.setState({ pct: p.pct }), "settings", true, voice, cfg);
    useDownload.setState({ state: "idle", pct: 0 });
    void qc.invalidateQueries({ queryKey: ["flow-voice"] });
    // Flow's runtime lives in another renderer: it reads the cache again, which clears its orb card.
    flowBridge()?.settingsChanged?.();
  } catch (e) {
    log.warn("flow", "voice models download:", e);
    useDownload.setState({ state: "failed" });
  }
}

const subscribeOnline = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => { window.removeEventListener("online", fn); window.removeEventListener("offline", fn); };
};

/** Where Flow's own voice models stand, read for the engines Flow hears and speaks with. */
export function useFlowVoiceSetup(config: FlowConfig | null) {
  const qc = useQueryClient();
  const saved = useVoicePrefs((s) => s.pipeline);
  const callOpen = useLiveStore((s) => s.active);
  const dl = useDownload();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const voice = config?.voice.speakReplies ?? true;
  const cfg = useMemo(() => withSurfaceVoice(loadPipelineConfig(), surfaceVoice(config, "flow")), [config, saved]);
  const key = [voice, cfg.stt.variant, cfg.stt.whisperSize, cfg.tts.variant, cfg.language].join(":");

  const read = useQuery({ queryKey: ["flow-voice", "settled", key], queryFn: () => modelsCachedSettled(voice, cfg), staleTime: Infinity, enabled: !!config });
  const settled = read.isSuccess || read.isError;
  const cached = settled && modelsCached(voice, cfg);
  const planned = useQuery({ queryKey: ["flow-voice", "plan", key, online], queryFn: () => voiceDownloadPlan(voice, cfg), enabled: settled && !cached, staleTime: 60_000 });

  const step = voiceSetupStep({
    models: voiceModels(settled, cached, planned.data, planned.isError), plan: planned.data ?? null, downloading: dl.state === "downloading", failed: dl.state === "failed", online,
  });
  return { step, plan: planned.data ?? null, pct: dl.pct, blocked: callOpen, start: () => void download(cfg, voice, qc) };
}

export type FlowVoiceSetup = ReturnType<typeof useFlowVoiceSetup>;
