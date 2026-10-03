"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentLabel } from "@openlive/shared";
import { api } from "@/lib/api";
import { flowBridge } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useUi } from "@/lib/uiStore";
import { desktopPlatform } from "@/lib/platform";
import { modelsCached, voiceDownloadPlan } from "./models";
import { aboutSize } from "./weights";
import { useApiModeChoice } from "./useApiModeChoice";
import { useLiveStore } from "./liveStore";

// Whether a new call would start, as Chat's home chip and Settings > Chat say
// it, and the one fix for what is missing, in the order the lobby asks: who
// answers first, then the models Start would download, then the microphone.

export type ChatGap = "agent_install" | "agent_signin" | "key" | "models" | "mic";

export interface ChatReadiness {
  /** Null while ready, or while it is still being read. */
  gap: ChatGap | null;
  loading: boolean;
  /** What the chip says. */
  label: string;
  /** What fixing it does, for the tooltip. */
  tip: string;
  fix: () => void;
}

/** Whether the microphone was refused. Never asks: a call asks when it starts. */
function useMicRefused(): boolean {
  const desktop = useFlowCapabilities().caps?.permissions?.microphone;
  const [browser, setBrowser] = useState<PermissionState | null>(null);
  useEffect(() => {
    if (flowBridge() || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    void navigator.permissions.query({ name: "microphone" as PermissionName }).then((s) => {
      status = s;
      setBrowser(s.state);
      s.onchange = () => setBrowser(s.state);
    }, () => {});
    return () => { if (status) status.onchange = null; };
  }, []);
  return desktop === "denied" || desktop === "restricted" || browser === "denied";
}

export function useChatReadiness(): ChatReadiness {
  const agent = useLiveStore((s) => s.boundAgent);
  const choice = useApiModeChoice();
  const { data: agents, isLoading: agentsLoading } = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: !!agent });
  const row = agent ? agents?.find((r) => r.id === agent) : undefined;
  const cached = typeof window !== "undefined" && modelsCached();
  const micRefused = useMicRefused();
  const open = useUi.getState().openSettingsTab;
  const name = agentLabel(agent);

  const first: ChatGap | null = agent && row && !row.installed ? "agent_install"
    : agent && row?.credState === "login_required" ? "agent_signin"
    : !agent && !choice.loading && !choice.usable ? "key" : null;
  // The size is asked of the hub only when the download is what the chip would say.
  const { data: plan } = useQuery({ queryKey: ["voice-download-plan"], queryFn: () => voiceDownloadPlan(), enabled: !cached && !first, staleTime: 60_000 });
  const gap: ChatGap | null = first
    ?? (!cached && (!plan || plan.missing.length > 0) ? "models"
    : micRefused ? "mic" : null);
  const size = aboutSize(plan?.bytes ?? null);

  switch (gap) {
    case "agent_install": return { gap, loading: false, label: `Install ${name}`, tip: `Chat answers with ${name}, which isn't installed yet`, fix: () => open("agents") };
    case "agent_signin": return { gap, loading: false, label: `Sign in to ${name}`, tip: `${name} needs you to sign in`, fix: () => open("agents") };
    case "key": return { gap, loading: false, label: "Add an API key", tip: "Chat needs a key, or a coding agent, to answer", fix: () => open("models", { anchor: "set-models-provider" }) };
    case "models": return { gap, loading: false, label: size ? `Download voice models, ${size}` : "Download voice models", tip: "Speech recognition and voice run on this device once they're downloaded", fix: () => open("engine", { anchor: "set-engine-stage-stt" }) };
    case "mic": return {
      gap, loading: false, label: "Allow microphone", tip: flowBridge() ? "Chat hears you through the microphone" : "Allow the microphone in your browser's site settings",
      // Refused once, the OS no longer asks, so the fix is its settings page where it has one.
      fix: () => { const b = flowBridge(); if (b) void (desktopPlatform === "linux" ? b.request("microphone", "other") : b.openSettings("microphone")); },
    };
    default: return { gap: null, loading: choice.loading || (!!agent && agentsLoading), label: "Ready", tip: "A new call can start", fix: () => {} };
  }
}
