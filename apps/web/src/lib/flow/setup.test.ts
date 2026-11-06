import { describe, expect, it } from "vitest";
import { voiceSetupStep } from "./setup";

describe("voiceSetupStep", () => {
  const base = { models: "missing" as const, plan: { missing: [], bytes: 1e8 }, downloading: false, failed: false, online: true };
  it("shows no prompt until the weights are read, or when none are needed", () => {
    expect(voiceSetupStep({ ...base, models: "reading" })).toBe("reading");
    expect(voiceSetupStep({ ...base, models: "ready" })).toBe("ready");
  });
  it("asks when weights are missing, with or without a size", () => {
    expect(voiceSetupStep(base)).toBe("ask");
    expect(voiceSetupStep({ ...base, plan: null })).toBe("ask");
  });
  it("says offline before it asks or fails, and downloading before everything", () => {
    expect(voiceSetupStep({ ...base, online: false })).toBe("offline");
    expect(voiceSetupStep({ ...base, online: false, failed: true })).toBe("offline");
    expect(voiceSetupStep({ ...base, failed: true })).toBe("failed");
    expect(voiceSetupStep({ ...base, downloading: true, online: false, models: "reading" })).toBe("downloading");
  });
});
