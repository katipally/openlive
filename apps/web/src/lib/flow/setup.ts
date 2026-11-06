import { isAgentId } from "@openlive/shared";
import type { AgentStatus } from "../api";
import { offerStep, type OfferStep } from "../live/lobbyGap";
import type { DownloadPlan } from "../live/weights";

/** A coding agent that is installed, signed in and not hidden: a brain that needs no API key. Pure. */
export const readyAgent = (rows: AgentStatus[] | undefined): AgentStatus | undefined =>
  rows?.find((r) => isAgentId(r.id) && r.installed && r.credState === "ready" && !r.hidden);

export type VoiceSetupStep = OfferStep | "reading" | "ready";

/** Where Flow's voice models stand for its first run. `models` is weights.ts voiceModels,
 *  which stays "reading" until the cache and the agent's voice have both been read, so no
 *  prompt appears for weights a native engine never needs. A plan the hub would not list
 *  still asks, without a size. Pure. */
export function voiceSetupStep(o: { models: "reading" | "missing" | "ready"; plan: DownloadPlan | null; downloading: boolean; failed: boolean; online: boolean }): VoiceSetupStep {
  if (o.downloading) return "downloading";
  if (o.models !== "missing") return o.models;
  return offerStep({ open: true, plan: o.plan ?? { missing: [], bytes: null }, downloading: false, failed: o.failed, online: o.online }) ?? "ask";
}
