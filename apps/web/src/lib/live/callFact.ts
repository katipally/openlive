import type { TelemetryFactProps } from "@openlive/shared";
import { roundMs } from "./perf";

// What the main window's hook knows about one call, kept as one plain object
// and sent as a single fact from teardown. Counts and flags only.

type Fact = TelemetryFactProps<"call_renderer">;
export type CallEndedBy = NonNullable<Fact["ended_by"]>;

export interface CallFact {
  /** performance.now() when Start was pressed. 0 while there is no call. */
  startedAt: number;
  /** `perf.mark()` at Start: this call's latency is the turns recorded after it. */
  mark: number;
  startMs?: number;
  startResult?: NonNullable<Fact["start_result"]>;
  bargeIns: number;
  typedTurns: number;
  camera: boolean;
  screen: boolean;
  ptt: boolean;
  micLost: number;
  cameraFailed: number;
  screenFailed: number;
  linkDrops: number;
  permByVoice: number;
}

export const newCallFact = (): CallFact => ({ startedAt: 0, mark: 0, bargeIns: 0, typedTurns: 0, camera: false, screen: false, ptt: false, micLost: 0, cameraFailed: 0, screenFailed: 0, linkDrops: 0, permByVoice: 0 });

/** `hasFolder` is whether a project folder is set, never which. */
export const callFactProps = (f: CallFact, endedBy: CallEndedBy, hasFolder: boolean, speech: Fact): Fact => ({
  ended_by: endedBy,
  ...(f.startResult && { start_result: f.startResult }),
  ...(f.startMs !== undefined && { start_ms: roundMs(f.startMs) }),
  barge_ins: f.bargeIns,
  typed_turns: f.typedTurns,
  camera_used: f.camera,
  screen_used: f.screen,
  ptt_used: f.ptt,
  has_folder: hasFolder,
  mic_lost: f.micLost,
  camera_failed: f.cameraFailed,
  screen_failed: f.screenFailed,
  link_drops: f.linkDrops,
  perm_by_voice: f.permByVoice,
  ...speech,
});
