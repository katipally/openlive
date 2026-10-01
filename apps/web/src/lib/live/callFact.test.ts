import { describe, expect, it } from "vitest";
import { callFactProps, newCallFact } from "./callFact";

describe("callFactProps", () => {
  it("reports counts and flags, with the folder as a boolean and every count sent even at zero", () => {
    expect(callFactProps(newCallFact(), "end_button", false, {})).toEqual({
      ended_by: "end_button", barge_ins: 0, typed_turns: 0, camera_used: false, screen_used: false, ptt_used: false,
      has_folder: false, mic_lost: 0, camera_failed: 0, screen_failed: 0, link_drops: 0, perm_by_voice: 0,
    });
  });

  it("carries what happened, rounds the start time to 10 ms and folds in the speech numbers", () => {
    const f = newCallFact();
    Object.assign(f, { startResult: "ok", startMs: 987.6, bargeIns: 2, typedTurns: 1, camera: true, ptt: true, micLost: 1, cameraFailed: 2, screenFailed: 1, linkDrops: 1, permByVoice: 3 });
    expect(callFactProps(f, "orb_end", true, { v2v_turns: 4, stt_family: "whisper" })).toMatchObject({
      ended_by: "orb_end", start_result: "ok", start_ms: 990, barge_ins: 2, typed_turns: 1, camera_used: true, screen_used: false,
      ptt_used: true, has_folder: true, mic_lost: 1, camera_failed: 2, screen_failed: 1, link_drops: 1, perm_by_voice: 3, v2v_turns: 4, stt_family: "whisper",
    });
  });

  it("omits the start result and time for a call that ended before it was up", () => {
    const props = callFactProps(newCallFact(), "switched_chat", false, {});
    expect(props).not.toHaveProperty("start_result");
    expect(props).not.toHaveProperty("start_ms");
  });

  it("gives every call its own object", () => {
    const a = newCallFact();
    a.bargeIns = 4;
    expect(newCallFact().bargeIns).toBe(0);
  });
});
