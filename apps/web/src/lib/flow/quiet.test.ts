import { describe, expect, it } from "vitest";
import { decideQuiet, NO_SIGNALS, type QuietRules } from "./quiet";

const RULES: QuietRules = { speakReplies: true, meetingApps: true, micContention: true, systemDnd: true, apps: [] };

describe("decideQuiet", () => {
  it("speaks when nothing says otherwise", () => {
    expect(decideQuiet(NO_SIGNALS, RULES)).toBe("");
  });

  it("never quiets on a signal it could not read", () => {
    expect(decideQuiet({ app: null, inCall: null, dnd: null, outputMuted: null, micBusy: null }, RULES)).toBe("");
  });

  it("quiets on a meeting app in the foreground", () => {
    expect(decideQuiet({ ...NO_SIGNALS, app: "zoom.us" }, RULES)).toBe("meeting");
  });

  it("quiets on a call that is actually up", () => {
    expect(decideQuiet({ ...NO_SIGNALS, inCall: true }, RULES)).toBe("meeting");
  });

  it("honours the user's own app list", () => {
    expect(decideQuiet({ ...NO_SIGNALS, app: "OBS Studio" }, { ...RULES, apps: ["obs"] })).toBe("meeting");
  });

  it("reports each remaining signal by name", () => {
    expect(decideQuiet({ ...NO_SIGNALS, micBusy: true }, RULES)).toBe("mic_busy");
    expect(decideQuiet({ ...NO_SIGNALS, dnd: true }, RULES)).toBe("dnd");
    expect(decideQuiet({ ...NO_SIGNALS, outputMuted: true }, RULES)).toBe("output_muted");
  });

  it("obeys a rule the user turned off", () => {
    expect(decideQuiet({ ...NO_SIGNALS, dnd: true }, { ...RULES, systemDnd: false })).toBe("");
  });

  it("stays quiet when replies are configured not to be spoken", () => {
    expect(decideQuiet(NO_SIGNALS, { ...RULES, speakReplies: false })).toBe("off");
  });
});
