import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { DAY_1, DAY_2, tmpDir } from "./rig";

const require = createRequire(import.meta.url);
const { createLimits } = require("./limits.cjs");
const { createState } = require("./state.cjs");
const schema = require("./schema.json");

const timers = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: NodeJS.Timeout) => clearTimeout(t) };

function make(dir = tmpDir(), start = DAY_1.getTime()) {
  let t = start;
  const state = createState({ dir, fs, timers });
  const limits = createLimits({ schema, state, now: () => t });
  return { state, limits, at: (ms: number) => (t = ms), advance: (ms: number) => (t += ms), dir };
}

describe("limits", () => {
  it("lets an event with no limit through every time", () => {
    const { limits } = make();
    for (let i = 0; i < 50; i++) expect(limits.admit("tray_action", { action: "open" })).toBe(true);
  });

  it("caps per launch, with or without a key", () => {
    const { limits } = make();
    expect(limits.admit("app_launch", {})).toBe(true);
    expect(limits.admit("app_launch", {})).toBe(false);
    for (let i = 0; i < 3; i++) expect(limits.admit("main_exception", { process: "main", kind: "uncaught" })).toBe(true);
    expect(limits.admit("main_exception", { process: "main", kind: "uncaught" })).toBe(false);
    expect(limits.admit("main_exception", { process: "agent", kind: "uncaught" })).toBe(true);
  });

  it("caps per day, and starts again the next day", () => {
    const { limits, at } = make();
    for (let i = 0; i < 3; i++) expect(limits.admit("flow_consent_result", { outcome: "declined" })).toBe(true);
    expect(limits.admit("flow_consent_result", { outcome: "declined" })).toBe(false);
    at(DAY_2.getTime());
    expect(limits.admit("flow_consent_result", { outcome: "declined" })).toBe(true);
  });

  it("caps per day per key", () => {
    const { limits } = make();
    for (let i = 0; i < 3; i++) expect(limits.admit("setting_changed", { setting: "theme", value: "dark" })).toBe(true);
    expect(limits.admit("setting_changed", { setting: "theme", value: "light" })).toBe(false);
    expect(limits.admit("setting_changed", { setting: "look", value: "flat" })).toBe(true);
    expect(limits.admit("lobby_blocked", { gap: "no_mic" })).toBe(true);
    expect(limits.admit("lobby_blocked", { gap: "no_mic" })).toBe(false);
    expect(limits.admit("lobby_blocked", { gap: "folder_unset" })).toBe(true);
  });

  it("caps an update result per stage, error kind and whether the check was asked for, so a manual failure is not lost to the launch check's", () => {
    const { limits } = make();
    const failed = { stage: "failed", error_kind: "network" };
    expect(limits.admit("update_result", { ...failed, manual: false })).toBe(true);
    expect(limits.admit("update_result", { ...failed, manual: false })).toBe(false);
    expect(limits.admit("update_result", { ...failed, manual: true })).toBe(true);
    expect(limits.admit("update_result", { ...failed, manual: true })).toBe(false);
    expect(limits.admit("update_result", { stage: "failed", error_kind: "other", manual: true })).toBe(true);
    expect(limits.admit("update_result", { stage: "downloaded", to_version: "1.2.3" })).toBe(true);
    expect(limits.admit("update_result", { stage: "downloaded", to_version: "1.2.3" })).toBe(false);
  });

  it("keeps the day counts across a restart, so a relaunch does not reopen the cap", () => {
    const first = make();
    expect(first.limits.admit("app_active_day", { first_surface: "flow" })).toBe(true);
    first.state.save();
    const second = make(first.dir);
    expect(second.limits.admit("app_active_day", { first_surface: "flow" })).toBe(false);
    second.at(DAY_2.getTime());
    expect(second.limits.admit("app_active_day", { first_surface: "flow" })).toBe(true);
  });

  it("drops an identical event inside its dedupe window, keyed by the props it names", () => {
    const { limits, advance } = make();
    const e = { surface: "flow", class: "quota", brain_id: "openai" };
    expect(limits.admit("brain_error", e)).toBe(true);
    advance(299_000);
    expect(limits.admit("brain_error", e)).toBe(false);
    expect(limits.admit("brain_error", { ...e, surface: "call" })).toBe(false);
    expect(limits.admit("brain_error", { ...e, brain_id: "groq" })).toBe(true);
    advance(2_000);
    expect(limits.admit("brain_error", e)).toBe(true);
  });

  it("sends a once-per-install event once, and a once-per-value event once per value, across restarts", () => {
    const first = make();
    expect(first.limits.admit("app_first_open", { origin: "fresh", launch_kind: "manual" })).toBe(true);
    expect(first.limits.admit("app_first_open", { origin: "fresh", launch_kind: "manual" })).toBe(false);
    expect(first.limits.admit("onboarding_step", { step: "first_call" })).toBe(true);
    expect(first.limits.admit("onboarding_step", { step: "first_call" })).toBe(false);
    expect(first.limits.admit("onboarding_step", { step: "first_flow_summon" })).toBe(true);
    first.state.save();
    const second = make(first.dir);
    expect(second.limits.admit("onboarding_step", { step: "first_call" })).toBe(false);
    expect(second.limits.admit("app_first_open", { origin: "fresh", launch_kind: "manual" })).toBe(false);
    expect(second.limits.admit("voice_bench_result", { engine_family: "piper", engine_kind: "tts", chosen_provider: "cpu" })).toBe(true);
    expect(second.limits.admit("voice_bench_result", { engine_family: "piper", engine_kind: "tts", chosen_provider: "cpu" })).toBe(false);
    expect(second.limits.admit("voice_bench_result", { engine_family: "kitten", engine_kind: "tts", chosen_provider: "cpu" })).toBe(true);
  });

  it("does not count an event it refused against its other caps", () => {
    const { limits, advance } = make();
    const e = { surface: "main", kind: "uncaught" };
    expect(limits.admit("renderer_error", e)).toBe(true);
    for (let i = 0; i < 5; i++) expect(limits.admit("renderer_error", e)).toBe(false);
    for (let i = 0; i < 2; i++) {
      advance(601_000);
      expect(limits.admit("renderer_error", e)).toBe(true);
    }
    advance(601_000);
    expect(limits.admit("renderer_error", e)).toBe(false);
    expect(limits.admit("renderer_error", { surface: "owner", kind: "uncaught" })).toBe(true);
  });

  it("starts over for a new install ID", () => {
    const { limits } = make();
    expect(limits.admit("onboarding_step", { step: "first_call" })).toBe(true);
    limits.reset();
    expect(limits.admit("onboarding_step", { step: "first_call" })).toBe(true);
  });
});
