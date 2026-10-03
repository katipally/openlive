import { describe, expect, it } from "vitest";
import type { FlowCapabilities } from "./bridge";
import { afterWelcome, allGranted, flowOnboardingDue } from "./onboarding";

const caps = (permissions: Partial<NonNullable<FlowCapabilities["permissions"]>>, capture = true) =>
  ({ permissions: { microphone: "granted", accessibility: true, screenRecording: true, ...permissions }, report: { capture } }) as FlowCapabilities;

describe("flowOnboardingDue", () => {
  it("shows the access step to someone new", () => {
    expect(flowOnboardingDue(null)).toBe(true);
  });

  it("is done once Welcome covered access, since who answers is picked there", () => {
    expect(flowOnboardingDue(afterWelcome(null, true, false))).toBe(false);
    // What a build with a second step left for someone between the two.
    expect(flowOnboardingDue("access")).toBe(false);
  });

  it("is done once Flow's own run finished", () => {
    expect(flowOnboardingDue("1")).toBe(false);
  });
});

describe("afterWelcome", () => {
  it("counts the access step when it was passed, granted or not", () => {
    expect(afterWelcome(null, true, false)).toBe("1");
  });

  it("counts a skip only when nothing was left to grant", () => {
    expect(afterWelcome(null, false, true)).toBe("1");
    expect(afterWelcome(null, false, false)).toBeNull();
  });

  it("never reopens a finished run", () => {
    expect(afterWelcome("1", false, false)).toBe("1");
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
