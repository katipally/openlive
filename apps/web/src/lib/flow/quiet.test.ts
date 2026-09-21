import { describe, expect, it } from "vitest";
import { decideQuiet, NO_SIGNALS, type QuietRules } from "./quiet";

const RULES: QuietRules = { speakReplies: true, meetingApps: true, micContention: true, systemDnd: true, apps: [] };

describe("decideQuiet", () => {
  it("speaks when nothing says otherwise", () => {
    expect(decideQuiet(NO_SIGNALS, RULES, null)).toBe("");
  });

  it("never quiets on a signal it could not read", () => {
    expect(decideQuiet({ app: null, inCall: null, dnd: null, outputMuted: null, micBusy: null }, RULES, null)).toBe("");
  });

  it("quiets on a meeting app in the foreground", () => {
    expect(decideQuiet({ ...NO_SIGNALS, app: "zoom.us" }, RULES, null)).toBe("meeting");
  });

  it("quiets on a call that is actually up", () => {
    expect(decideQuiet({ ...NO_SIGNALS, inCall: true }, RULES, null)).toBe("meeting");
  });

  it("honours the user's own app list", () => {
    expect(decideQuiet({ ...NO_SIGNALS, app: "OBS Studio" }, { ...RULES, apps: ["obs"] }, null)).toBe("meeting");
  });

  it("reports each remaining signal by name", () => {
    expect(decideQuiet({ ...NO_SIGNALS, micBusy: true }, RULES, null)).toBe("mic_busy");
    expect(decideQuiet({ ...NO_SIGNALS, dnd: true }, RULES, null)).toBe("dnd");
    expect(decideQuiet({ ...NO_SIGNALS, outputMuted: true }, RULES, null)).toBe("output_muted");
  });

  it("obeys a rule the user turned off", () => {
    expect(decideQuiet({ ...NO_SIGNALS, dnd: true }, { ...RULES, systemDnd: false }, null)).toBe("");
  });

  it("lets the manual override win in both directions", () => {
    expect(decideQuiet({ ...NO_SIGNALS, app: "zoom.us", dnd: true }, RULES, true)).toBe("");
    expect(decideQuiet(NO_SIGNALS, RULES, false)).toBe("off");
  });

  it("stays quiet when replies are configured not to be spoken", () => {
    expect(decideQuiet(NO_SIGNALS, { ...RULES, speakReplies: false }, null)).toBe("off");
  });
});
