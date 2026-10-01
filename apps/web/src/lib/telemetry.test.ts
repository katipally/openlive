import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetry } from "./telemetry";

type Fake = Record<"track" | "fact" | "count" | "noticeShown" | "get" | "set", ReturnType<typeof vi.fn>>;
const install = (overrides: Partial<Fake> = {}): Fake => {
  const fake: Fake = {
    track: vi.fn(), fact: vi.fn(), count: vi.fn(), noticeShown: vi.fn(),
    get: vi.fn(async () => ({ active: true, enabled: true })), set: vi.fn(async () => {}),
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = { openlive: { telemetry: fake } };
  return fake;
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("telemetry wrapper", () => {
  it("is a silent no-op without a window or without the bridge", async () => {
    telemetry.track("tray_action", { action: "open" });
    telemetry.fact("flow_owner", { stops: 1 });
    telemetry.count("n_settings_open");
    telemetry.noticeShown();
    expect(await telemetry.get()).toBeNull();
    await telemetry.set(false, "settings");
    (globalThis as { window?: unknown }).window = { openlive: {} };
    telemetry.count("n_settings_open");
    expect(await telemetry.get()).toBeNull();
  });

  it("passes each call through to the bridge", async () => {
    const fake = install();
    telemetry.track("tray_action", { action: "quit" });
    telemetry.fact("call_renderer", { typed_turns: 2 });
    telemetry.count("n_palette_run");
    telemetry.noticeShown();
    await telemetry.set(true, "notice");
    expect(fake.track).toHaveBeenCalledWith("tray_action", { action: "quit" });
    expect(fake.fact).toHaveBeenCalledWith("call_renderer", { typed_turns: 2 });
    expect(fake.count).toHaveBeenCalledWith("n_palette_run");
    expect(fake.noticeShown).toHaveBeenCalledOnce();
    expect(fake.set).toHaveBeenCalledWith(true, "notice");
    expect(await telemetry.get()).toEqual({ active: true, enabled: true });
  });

  it("never throws, whether the bridge throws or rejects", async () => {
    const boom = () => {
      throw new Error("ipc gone");
    };
    install({ track: vi.fn(boom), fact: vi.fn(boom), count: vi.fn(boom), noticeShown: vi.fn(boom), get: vi.fn(boom), set: vi.fn(boom) });
    expect(() => {
      telemetry.track("tray_action", { action: "open" });
      telemetry.fact("flow_owner", {});
      telemetry.count("n_camera_on");
      telemetry.noticeShown();
    }).not.toThrow();
    expect(await telemetry.get()).toBeNull();
    await expect(telemetry.set(false, "settings")).resolves.toBeUndefined();
    install({ track: vi.fn(async () => Promise.reject(new Error("rejected"))) });
    expect(() => telemetry.track("tray_action", { action: "open" })).not.toThrow();
  });

  it("hands a once-only event over once per value, not on every call", () => {
    const fake = install();
    telemetry.track("onboarding_step", { step: "first_settings_open" });
    telemetry.track("onboarding_step", { step: "first_settings_open" });
    telemetry.track("onboarding_step", { step: "first_call_turn" });
    expect(fake.track).toHaveBeenCalledTimes(2);
    telemetry.track("tray_action", { action: "open" });
    telemetry.track("tray_action", { action: "open" });
    expect(fake.track).toHaveBeenCalledTimes(4);
  });

  it("does not spend a once-only key while no shell is there to take it", () => {
    telemetry.track("onboarding_step", { step: "first_ptt_on" });
    const fake = install();
    telemetry.track("onboarding_step", { step: "first_ptt_on" });
    expect(fake.track).toHaveBeenCalledOnce();
  });
});

describe("telemetry wrapper feedback prompts", () => {
  const feedbackBridge = (over: Record<string, unknown> = {}) => {
    const fake = { feedbackNext: vi.fn(async () => ({ kind: "nps", surface: "main" })), feedbackAnswer: vi.fn(), setFeedback: vi.fn(async () => {}), ...over };
    (globalThis as { window?: unknown }).window = { openlive: { telemetry: fake } };
    return fake;
  };

  it("offers nothing without a shell, and is silent about answers", async () => {
    expect(await telemetry.feedbackNext()).toBeNull();
    expect(() => telemetry.feedbackAnswer({ outcome: "ignored" })).not.toThrow();
    await expect(telemetry.setFeedback(false)).resolves.toBeUndefined();
  });

  it("hands the shell's offer and the person's answer through", async () => {
    const fake = feedbackBridge();
    expect(await telemetry.feedbackNext()).toEqual({ kind: "nps", surface: "main" });
    telemetry.feedbackAnswer({ outcome: "answered", score: 8 });
    await telemetry.setFeedback(false);
    expect(fake.feedbackAnswer).toHaveBeenCalledWith({ outcome: "answered", score: 8 });
    expect(fake.setFeedback).toHaveBeenCalledWith(false);
  });

  it("never throws or waits on a shell that fails", async () => {
    feedbackBridge({ feedbackNext: vi.fn(async () => Promise.reject(new Error("gone"))), feedbackAnswer: vi.fn(() => { throw new Error("clone"); }), setFeedback: vi.fn(async () => Promise.reject(new Error("gone"))) });
    expect(await telemetry.feedbackNext()).toBeNull();
    expect(() => telemetry.feedbackAnswer({ outcome: "ignored" })).not.toThrow();
    await expect(telemetry.setFeedback(true)).resolves.toBeUndefined();
  });
});
