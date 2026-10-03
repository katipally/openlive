import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { coerce, validateEvent, validateFact, validateCommon, isCounterKey } = createRequire(import.meta.url)("./validate.cjs");

describe("validateEvent", () => {
  it("keeps a valid event exactly", () => {
    expect(validateEvent("tray_action", { action: "quit" })).toEqual({ action: "quit" });
    expect(validateEvent("app_launch", { launch_kind: "login", boot_result: "ok", boot_ms: 1500, agent_port_moved: false })).toEqual({
      launch_kind: "login", boot_result: "ok", boot_ms: 1500, agent_port_moved: false,
    });
  });

  it("drops an unknown event, including names that exist on every object", () => {
    for (const name of ["nope", "", "__proto__", "constructor", "toString", "hasOwnProperty", 7, null, undefined, {}]) {
      expect(validateEvent(name as string, { action: "quit" })).toBeNull();
    }
  });

  it("drops unknown props and keeps the rest", () => {
    const out = validateEvent("tray_action", { action: "open", path: "/Users/me/secret", email: "a@b.c", __proto__: { action: "quit" } });
    expect(out).toEqual({ action: "open" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("drops the common props if a caller passes them, since the sender owns those", () => {
    expect(validateEvent("tray_action", { action: "open", app_version: "1.2.3", platform: "darwin" })).toEqual({ action: "open" });
  });

  it("drops a string where a number is expected, and a number where a string or enum is expected", () => {
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", boot_ms: "1500" })).toEqual({ launch_kind: "manual", boot_result: "ok" });
    expect(validateEvent("tray_action", { action: 3 })).toBeNull();
    expect(validateEvent("app_updated", { from_version: 1, to_version: "1.0.1" })).toBeNull();
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", login_item: "true" })).toEqual({ launch_kind: "manual", boot_result: "ok" });
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", boot_ms: 10n })).toEqual({ launch_kind: "manual", boot_result: "ok" });
  });

  it("drops long strings and anything off the version shape", () => {
    expect(validateEvent("app_updated", { from_version: "1.2.3", to_version: "1.2.3-beta.1" })).toEqual({ from_version: "1.2.3", to_version: "1.2.3-beta.1" });
    expect(validateEvent("app_updated", { from_version: "1.2.3", to_version: `1.2.3-${"a".repeat(30)}` })).toBeNull();
    expect(validateEvent("app_updated", { from_version: "1.2.3", to_version: "v1.2.3" })).toBeNull();
    expect(validateEvent("app_updated", { from_version: "1.2.3", to_version: "1.2.3\n/Users/me" })).toBeNull();
    expect(validateEvent("tray_action", { action: "x".repeat(100_000) })).toBeNull();
    expect(validateEvent("update_result", { stage: "failed", to_version: "1.2.3 with the error text here" })).toEqual({ stage: "failed" });
  });

  it("drops nested objects, arrays and functions as values", () => {
    expect(validateEvent("tray_action", { action: { nested: "open" } })).toBeNull();
    expect(validateEvent("tray_action", { action: ["open"] })).toBeNull();
    expect(validateEvent("tray_action", { action: () => "open" })).toBeNull();
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", boot_ms: { v: 1 }, theme: ["dark"] })).toEqual({ launch_kind: "manual", boot_result: "ok" });
  });

  it("drops an out-of-set enum: the prop when optional, the event when required", () => {
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", theme: "neon" })).toEqual({ launch_kind: "manual", boot_result: "ok" });
    expect(validateEvent("app_launch", { launch_kind: "manual", boot_result: "melted" })).toBeNull();
    expect(validateEvent("brain_error", { surface: "flow", class: "the api key sk-123 was rejected" })).toBeNull();
  });

  it("drops an over-cap number and a bad one, rounds the rest", () => {
    expect(validateEvent("service_crashed", { service: "web", outcome: "gave_up", respawn_n: 100 })).toEqual({ service: "web", outcome: "gave_up" });
    expect(validateEvent("telemetry_disabled", { from: "settings", days_since_first_open: 1000 })).toBeNull();
    expect(validateEvent("telemetry_disabled", { from: "settings", days_since_first_open: 999 })).toEqual({ from: "settings", days_since_first_open: 999 });
    expect(validateEvent("telemetry_disabled", { from: "settings", days_since_first_open: -1 })).toBeNull();
    for (const bad of [NaN, Infinity, -Infinity]) expect(validateEvent("telemetry_disabled", { from: "notice", days_since_first_open: bad })).toBeNull();
    const boot = (boot_ms: number) => validateEvent("app_launch", { launch_kind: "manual", boot_result: "ok", boot_ms })?.boot_ms;
    expect(boot(1234)).toBe(1200);
    expect(boot(1250)).toBe(1300);
    expect(boot(600_049)).toBe(600_000);
    expect(boot(600_050)).toBeUndefined();
    expect(validateEvent("app_quit", { via: "tray_menu", uptime_h: 1.26 })?.uptime_h).toBe(1.3);
    expect(validateEvent("app_quit", { via: "tray_menu", uptime_h: 0.04 })?.uptime_h).toBe(0);
    expect(validateEvent("voice_bench_result", { engine_family: "piper", engine_kind: "tts", chosen_provider: "cpu", cpu_rtf: 0.12345 })?.cpu_rtf).toBe(0.12);
  });

  it("allows the one negative it names and nothing else", () => {
    expect(validateEvent("crash_detected", { source: "gpu", reason: "crashed", exit_code: -1 })?.exit_code).toBe(-1);
    expect(validateEvent("crash_detected", { source: "gpu", reason: "crashed", exit_code: -2 })).toEqual({ source: "gpu", reason: "crashed" });
    expect(validateEvent("crash_detected", { source: "gpu", reason: "crashed", exit_code: 3221225477 })).toEqual({ source: "gpu", reason: "crashed" });
  });

  it("rounds sampled latencies and counters to whole numbers and steps", () => {
    const out = validateEvent("flow_session", { duration_s: 12.6, ended_by: "gesture", turns: 3, acted: true, ttft_ms_p50: 347, agent_start_ms: 1204 });
    expect(out).toMatchObject({ duration_s: 13, ttft_ms_p50: 350, agent_start_ms: 1200 });
  });

  it("treats a non-object props as empty, and never throws", () => {
    for (const props of [null, undefined, "open", 5, ["open"]]) expect(validateEvent("tray_action", props)).toBeNull();
    expect(validateEvent("feature_usage", null)).toEqual({});
    const hostile = { get action() { throw new Error("boom"); } };
    expect(() => validateEvent("tray_action", hostile)).not.toThrow();
    expect(validateEvent("tray_action", hostile)).toBeNull();
    expect(validateEvent("tray_action", new Proxy({}, { ownKeys() { throw new Error("boom"); } }))).toBeNull();
  });

  it("needs every required prop", () => {
    expect(validateEvent("flow_session", { duration_s: 4, ended_by: "idle", turns: 0 })).toBeNull();
    expect(validateEvent("flow_session", { duration_s: 4, ended_by: "idle", turns: 0, acted: false })).toEqual({ duration_s: 4, ended_by: "idle", turns: 0, acted: false });
  });
});

describe("setting_changed pairs", () => {
  const ok = (setting: string, value: string, extra = {}) => validateEvent("setting_changed", { setting, value, ...extra });

  it("accepts a value the setting lists and refuses one it does not", () => {
    expect(ok("theme", "dark")).toEqual({ setting: "theme", value: "dark" });
    expect(ok("theme", "glass")).toBeNull();
    expect(ok("look", "glass")).toEqual({ setting: "look", value: "glass" });
    expect(ok("login_item", "system")).toBeNull();
    expect(ok("end_on_lock", "off")).toEqual({ setting: "end_on_lock", value: "off" });
    expect(ok("end_on_lock", "on")).toBeTruthy();
    expect(ok("end_on_lock", "true")).toBeNull();
    expect(ok("api_effort", "xhigh")).toBeTruthy();
    expect(ok("api_effort", "on")).toBeNull();
    expect(ok("language", "ko")).toBeTruthy();
    expect(ok("language", "klingon")).toBeNull();
    expect(ok("close_after_silence", "never")).toBeTruthy();
  });

  it("refuses a setting that is not in the table, including inherited names", () => {
    for (const s of ["custom_instructions_text", "acpCommand:claude", "__proto__", "constructor", "toString"]) expect(ok(s, "on")).toBeNull();
    expect(ok("custom_instructions", "set")).toBeTruthy();
    expect(ok("custom_instructions", "please be brief")).toBeNull();
  });

  it("refuses a value that is in the enum but not for that setting", () => {
    expect(ok("api_model", "on")).toBeNull();
    expect(ok("provider_key", "changed")).toBeNull();
    expect(ok("provider_key", "added", { subject: "openai" })).toMatchObject({ subject: "openai" });
  });

  it("keeps a subject only of the kind the setting names", () => {
    expect(ok("api_provider", "none", { subject: "groq" })).toEqual({ setting: "api_provider", value: "none", subject: "groq" });
    expect(ok("api_provider", "none", { subject: "codex" })).toEqual({ setting: "api_provider", value: "none" });
    expect(ok("agent_hidden", "on", { subject: "codex" })).toMatchObject({ subject: "codex" });
    expect(ok("agent_hidden", "on", { subject: "groq" })).toEqual({ setting: "agent_hidden", value: "on" });
    expect(ok("flow_brain", "acp", { subject: "hermes" })).toMatchObject({ subject: "hermes" });
    expect(ok("flow_brain", "api", { subject: "none" })).toMatchObject({ subject: "none" });
    expect(ok("theme", "dark", { subject: "openai" })).toEqual({ setting: "theme", value: "dark" });
  });
});

describe("validateFact", () => {
  it("cleans a delta by its scope", () => {
    expect(validateFact("agent_flow", { turns: 1, t_see: 2, ttft_ms: 320, brain_kind: "api", path: "/x", tool_calls: "3" })).toEqual({
      turns: 1, t_see: 2, ttft_ms: 320, brain_kind: "api",
    });
    expect(validateFact("agent_call", { camera_used: true, lang: "xx", turns: 1000 })).toEqual({ camera_used: true });
  });

  it("is null for an unknown scope, and never carries a scope's props into another", () => {
    for (const scope of ["flow", "call", "nope", "__proto__", "constructor", undefined, 3]) expect(validateFact(scope as string, { turns: 1 })).toBeNull();
    expect(validateFact("flow_owner", { turns: 1, stops: 2 })).toEqual({ stops: 2 });
    expect(validateFact("call_renderer", { t_look: 1, typed_turns: 1 })).toEqual({ typed_turns: 1 });
  });

  it("does not throw on hostile input", () => {
    expect(validateFact("agent_flow", null)).toEqual({});
    expect(validateFact("agent_flow", new Proxy({}, { ownKeys() { throw new Error("boom"); } }))).toBeNull();
  });
});

describe("validateCommon and counters", () => {
  it("keeps only the six common props, shaped as the schema says", () => {
    expect(validateCommon({ app_version: "0.2.7", platform: "darwin", arch: "arm64", arch_translated: false, os_major: "26", username: "swift-otter-1a2b3c4d", hostname: "yash-mbp" })).toEqual({
      app_version: "0.2.7", platform: "darwin", arch: "arm64", arch_translated: false, os_major: "26", username: "swift-otter-1a2b3c4d",
    });
    expect(validateCommon({ app_version: "dev build", platform: "freebsd", os_major: "Sonoma 14.5" })).toEqual({});
    expect(validateCommon({ os_major: "linux" })).toEqual({ os_major: "linux" });
  });

  it("accepts a username only as adjective-animal and eight hex characters", () => {
    for (const ok of ["swift-otter-1a2b3c4d", "cat-elk-00000000", "whimsical-hummingbird-ffffffff"]) expect(validateCommon({ username: ok })).toEqual({ username: ok });
    const bad = [
      "Swift-Otter-1a2b3c4d", "swift-otter-1a2b3c4", "swift-otter-1a2b3c4d5", "swift-otter-1A2B3C4D", "swift-otter-1a2b3c4g", "swift_otter_1a2b3c4d",
      "swift-otter", "swift--1a2b3c4d", "sw-otter-1a2b3c4d", "swift-otter-1a2b3c4d\n", " swift-otter-1a2b3c4d", "swift-ott3r-1a2b3c4d",
      "yash-reddy-1a2b3c4d\nx", "swift-otter-1a2b3c4d-extra", "a".repeat(41), "", 5, null, {},
    ];
    for (const v of bad) expect(validateCommon({ username: v }), String(v)).toEqual({});
  });

  it("knows the 20 counter keys and no others", () => {
    expect(isCounterKey("n_settings_open")).toBe(true);
    expect(isCounterKey("n_call_shortcut")).toBe(true);
    for (const k of ["settings_open", "n_search_text", "__proto__", "constructor", "", 3, null]) expect(isCounterKey(k as string)).toBe(false);
  });
});

describe("coerce", () => {
  it("never returns a negative zero", () => {
    expect(Object.is(coerce({ k: "int", max: 9 }, -0), 0)).toBe(true);
    expect(Object.is(coerce({ k: "int", max: 9 }, -0.2), 0)).toBe(true);
    expect(Object.is(coerce({ k: "dec", max: 9, places: 1 }, -0.04), 0)).toBe(true);
  });
});
