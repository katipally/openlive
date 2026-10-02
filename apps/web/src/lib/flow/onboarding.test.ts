import { describe, expect, it } from "vitest";
import type { FlowCapabilities } from "./bridge";
import { afterWelcome, allGranted, flowOnboardingStep } from "./onboarding";

const caps = (permissions: Partial<NonNullable<FlowCapabilities["permissions"]>>, capture = true) =>
  ({ permissions: { microphone: "granted", accessibility: true, screenRecording: true, ...permissions }, report: { capture } }) as FlowCapabilities;

describe("flowOnboardingStep", () => {
  it("opens at the access step for someone new", () => {
    expect(flowOnboardingStep(null)).toBe(1);
  });

  it("opens at the brain step once Welcome covered access", () => {
    expect(flowOnboardingStep(afterWelcome(null, true, false))).toBe(2);
  });

  it("is done once Flow's own run finished", () => {
    expect(flowOnboardingStep("1")).toBeNull();
  });
});

describe("afterWelcome", () => {
  it("counts the access step when it was passed, granted or not", () => {
    expect(afterWelcome(null, true, false)).toBe("access");
  });

  it("counts a skip only when nothing was left to grant", () => {
    expect(afterWelcome(null, false, true)).toBe("access");
    expect(afterWelcome(null, false, false)).toBeNull();
  });

  it("never reopens a finished run", () => {
    expect(afterWelcome("1", true, true)).toBe("1");
  });
});

describe("allGranted", () => {
  it("needs every grant and consent", () => {
    expect(allGranted(caps({}), true)).toBe(true);
    expect(allGranted(caps({}), false)).toBe(false);
    expect(allGranted(caps({ microphone: "denied" }), true)).toBe(false);
    expect(allGranted(caps({ postEvents: false }), true)).toBe(false);
    expect(allGranted(caps({ screenRecording: false }), true)).toBe(false);
  });

  it("does not count a screen grant that needs a relaunch", () => {
    expect(allGranted(caps({}, false), true)).toBe(false);
  });

  it("knows nothing without the desktop", () => {
    expect(allGranted(null, true)).toBe(false);
  });
});
