import type { FlowConfig } from "@openlive/flow-store";
import type { SurfaceVoice } from "../live/pipelineConfig";

// Flow and Dictate hear with what Chat does, and Flow speaks with it, unless a
// surface has picked its own.

export type Surface = "flow" | "dictate";

/** The engines `surface` picked for itself, each only while its override is on.
 *  Dictate never speaks, so it has no voice to pick. Pure. */
export function surfaceVoice(cfg: Pick<FlowConfig, "voice" | "dictate"> | null | undefined, surface: Surface): SurfaceVoice | null {
  if (!cfg) return null;
  const stt = surface === "flow" ? cfg.voice.stt : cfg.dictate.stt;
  const tts = surface === "flow" ? cfg.voice.tts : undefined;
  return {
    ...(stt.override && { stt: { variant: stt.variant, whisperSize: stt.whisperSize } }),
    ...(tts?.override && { tts: { variant: tts.variant, voice: tts.voice } }),
  };
}
