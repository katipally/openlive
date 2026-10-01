import type { TelemetryFactProps } from "@openlive/shared";
import { sttFamilyOf, ttsFamilyOf } from "../telemetryIds";
import { hasWebGPU } from "./models";
import { latencyFact, perf } from "./perf";
import { loadPipelineConfig } from "./pipelineConfig";

type Speech = Pick<
  TelemetryFactProps<"call_renderer">,
  "stt_ms_p50" | "tts_ms_p50" | "v2v_ms_p50" | "v2v_turns" | "stt_family" | "tts_family" | "webgpu"
>;

/** What the on-device speech stack did since `mark` (perf.mark() when the Flow open or call began), for either fact. */
export function speechFacts(mark: number): Speech {
  const cfg = loadPipelineConfig();
  const stt = sttFamilyOf(cfg.stt.family);
  const tts = ttsFamilyOf(cfg.tts.family);
  return { ...latencyFact(perf.since(mark)), ...(stt && { stt_family: stt }), ...(tts && { tts_family: tts }), webgpu: hasWebGPU() };
}
