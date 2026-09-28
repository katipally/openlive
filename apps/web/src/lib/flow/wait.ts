import type { FlowConfig } from "@openlive/flow-store";
import { flowTurn } from "@openlive/flow-store/shared";
import { sharedWait, type PipelineConfig, type TurnPresetValues } from "../live/pipelineConfig";

// "Wait before answering" is set once for Chat and Flow; Flow may keep its own.

type FlowWait = Pick<FlowConfig, "voice">;

/** How long each mode waits before answering. Chat always waits the shared
 *  way; Flow does too unless its override is on. Pure. */
export function effectiveWait(mode: "chat" | "flow", pipeline: PipelineConfig, flow: FlowWait | null): TurnPresetValues {
  const own = mode === "flow" && flow ? flowTurn(flow) : null;
  return own ? { redemptionMs: own.redemptionMs, threshold: own.threshold, holdMs: own.holdMs } : sharedWait(pipeline);
}

/** The override a config from before the wait was shared should get: on when
 *  Flow's wait already differs from Chat's, so it keeps its behavior; off when
 *  they match, so it follows Chat from now on. Null when already decided. Pure. */
export function settleTurnOverride(flow: FlowWait, pipeline: PipelineConfig): boolean | null {
  if (flow.voice.turnOverride !== null) return null;
  const chat = sharedWait(pipeline);
  const own = flow.voice.turn;
  return own.redemptionMs !== chat.redemptionMs || own.threshold !== chat.threshold || own.holdMs !== chat.holdMs;
}
