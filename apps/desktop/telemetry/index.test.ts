import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CONFIG, count, DAY_1, DAY_2, fact, flush, modeOf, notice, rig, tmpDir } from "./rig";

const require = createRequire(import.meta.url);
const { createTelemetry } = require("./index.cjs");
const { usernameOf } = require("./username.cjs");

beforeEach(() => vi.useFakeTimers({ now: DAY_1 }));
afterEach(() => vi.useRealTimers());

/** A run of the app that has shown the notice and is ready to send. */
const ready = (over: Record<string, unknown> = {}) => {
  const r = rig(over);
  r.telemetry.start({ launchKind: "manual" });
  notice(r.telemetry);
  return r;
};
const queued = (r: ReturnType<typeof rig>) => r.queue().map((q) => q.n as string);

describe("when it must stay silent", () => {
  const off: [string, Record<string, unknown>][] = [
    ["an unpackaged build", { isPackaged: false }],
    ["a build with no stamped config", { config: null }],
    ["ELECTRON_DEV=1", { env: { ELECTRON_DEV: "1" } }],
    ["OPENLIVE_TELEMETRY=0", { env: { OPENLIVE_TELEMETRY: "0" } }],
    ["DO_NOT_TRACK=1", { env: { DO_NOT_TRACK: "1" } }],
    ["OPENLIVE_TELEMETRY=no", { env: { OPENLIVE_TELEMETRY: "no" } }],
    ["DO_NOT_TRACK=yes", { env: { DO_NOT_TRACK: "yes" } }],
    ["OPENLIVE_FLOW_HOME", { env: { OPENLIVE_FLOW_HOME: "/tmp/x" } }],
    ["a remote debugging port", { argv: ["app", "--remote-debugging-port=9333"] }],
    ["an inspector", { argv: ["app", "--inspect=9229"] }],
    ["no user data dir", { stateDir: "" }],
  ];

  it.each(off)("%s: no files, no requests, every method still callable", async (_, over) => {
    const dir = tmpDir();
    const r = rig({ stateDir: dir, ...over });
    const t = r.telemetry;
    t.start({ launchKind: "manual" });
    notice(t);
    t.track("tray_action", { action: "open" });
    fact(t, "agent_flow", { turns: 1 });
    count(t, "n_settings_open");
    t.markActiveDay("flow");
    t.reportOnboardingStep("first_call");
    t.reportReadiness({ to: "ready" });
    t.openFlow();
    t.closeFlow("gesture");
    t.openCall();
    t.closeCall("end_button");
    t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "event", name: "brain_error", props: { surface: "flow", class: "quota" } });
    t.handleRendererMessage({ t: "track", name: "renderer_error", props: { surface: "main", kind: "uncaught" } });
    await t.setEnabled(false, "settings");
    t.onQuit("tray_menu");
    await flush();
    expect(r.post).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(t.getStatus()).toMatchObject({ active: false, enabled: false, noticeSeen: false, installIdTail: "", username: "", feedback: false, appVersion: "1.2.3", osName: "macOS", osMajor: "15" });
  });

  it("exposes the same methods whether it is on or off", () => {
    expect(Object.keys(rig({ isPackaged: false }).telemetry).sort()).toEqual(Object.keys(rig().telemetry).sort());
  });

  it("reads the stamped config from configPath, and is off when the file is not there", () => {
    const dir = tmpDir();
    expect(rig({ stateDir: dir, config: undefined, configPath: `${dir}/nope.json` }).telemetry.getStatus().active).toBe(false);
    expect(rig({ config: undefined, configPath: undefined }).telemetry.getStatus().active).toBe(false);
  });

  it("never throws out of the factory", () => {
    for (const deps of [undefined, null, {}, { stateDir: 5 }, { isPackaged: true, config: CONFIG, stateDir: "/nonexistent/\0/x" }]) {
      expect(() => createTelemetry(deps)).not.toThrow();
    }
  });
});

describe("the notice gate", () => {
  it("keeps events in memory, never on disk, until the notice has been shown", async () => {
    const r = rig();
    r.telemetry.start({ launchKind: "manual" });
    r.telemetry.track("tray_action", { action: "open" });
    r.telemetry.markActiveDay("tray");
    r.telemetry.onQuit("tray_menu");
    await flush();
    expect(r.queue()).toEqual([]);
    expect(existsSync(r.file("telemetry-queue.jsonl"))).toBe(false);
    expect(r.post).not.toHaveBeenCalled();
  });

  it("releases them in order when the notice is shown, first open leading", async () => {
    const r = rig();
    r.telemetry.start({ launchKind: "manual" });
    r.telemetry.track("tray_action", { action: "open" });
    r.telemetry.track("tray_action", { action: "quit" });
    notice(r.telemetry);
    expect(queued(r)).toEqual(["app_first_open", "tray_action", "tray_action"]);
    await flush();
    expect(r.names()).toEqual(["app_first_open", "tray_action", "tray_action"]);
    expect(r.telemetry.getStatus().noticeSeen).toBe(true);
  });

  it("holds at most 200 events, dropping the oldest", () => {
    const r = rig();
    r.telemetry.start();
    for (let i = 0; i < 300; i++) r.telemetry.track("tray_action", { action: i < 100 ? "quit" : "open" });
    notice(r.telemetry);
    const tray = r.queue().filter((q) => q.n === "tray_action");
    expect(tray).toHaveLength(200);
    expect(tray.every((q) => q.p.action === "open")).toBe(true);
  });

  it("stays shown for the next run", () => {
    const first = ready();
    const second = first.again();
    expect(second.telemetry.getStatus().noticeSeen).toBe(true);
    second.telemetry.track("tray_action", { action: "open" });
    expect(queued(second)).toContain("tray_action");
  });

  it("waits 0 to 60 s from launch before the first request when the notice was already seen", async () => {
    const r = ready().again();
    r.telemetry.start();
    r.telemetry.track("tray_action", { action: "open" });
    await flush(29_000);
    expect(r.post).not.toHaveBeenCalled();
    await flush(3_000);
    expect(r.post).toHaveBeenCalled();
  });

  it("counts the wait from the notice, at least 15 s and at most 60 s, however long the app ran before it", async () => {
    for (const [random, at] of [[0, 15_000], [0.5, 37_500], [1, 60_000]] as const) {
      const r = rig({ random: () => random });
      r.telemetry.start({ launchKind: "login" });
      r.telemetry.track("tray_action", { action: "open" });
      await flush(10 * 60_000);
      notice(r.telemetry);
      await flush(at - 1_000);
      expect(r.post).not.toHaveBeenCalled();
      await flush(2_000);
      expect(r.names()).toContain("app_first_open");
    }
  });

  it("lets a person turn sharing off in that wait: only telemetry_disabled goes out, none of the held events", async () => {
    const r = rig();
    const t = r.telemetry;
    t.start({ launchKind: "manual" });
    t.track("tray_action", { action: "open" });
    t.markActiveDay("flow");
    await flush(3 * 60_000);
    notice(t);
    await flush(10_000);
    expect(r.post).not.toHaveBeenCalled();
    await t.setEnabled(false, "notice");
    await flush(10 * 60_000);
    expect(r.sent.map((s) => s.json.payload.name)).toEqual(["telemetry_disabled"]);
    expect(r.sent[0]!.json.payload.properties.from).toBe("notice");
    expect(r.queue()).toEqual([]);
  });

  it("never gives someone who just refused at the notice a named profile, but keeps the name on the event for a deletion request", async () => {
    const r = rig();
    const t = r.telemetry;
    t.start({ launchKind: "manual" });
    notice(t);
    const id = r.state().installId;
    await t.setEnabled(false, "notice");
    await flush(10_000);
    expect(r.sent).toHaveLength(1);
    const props = r.sent[0]!.json.payload.properties;
    expect(props).not.toHaveProperty("__identify");
    expect(props).toMatchObject({ username: usernameOf(id), from: "notice", __ip: "127.0.0.1" });
  });
});

describe("what is queued", () => {
  it("carries the common properties and a time rounded down to the minute", () => {
    vi.setSystemTime(new Date(2026, 8, 29, 12, 34, 56, 789));
    const r = ready();
    r.telemetry.track("tray_action", { action: "settings" });
    const rec = r.queue().find((q) => q.n === "tray_action")!;
    expect(rec.p).toEqual({ app_version: "1.2.3", platform: "darwin", arch: "arm64", arch_translated: false, os_major: "15", action: "settings" });
    expect(rec.t).toBe(new Date(2026, 8, 29, 12, 34, 0, 0).toISOString());
  });

  it("stamps an event with the minute it happened, not the minute it was sent", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await flush(300_000);
    const sent = r.sent.find((s) => s.json.payload.name === "tray_action")!;
    expect(sent.json.payload.properties.__timestamp).toBe(new Date(2026, 8, 29, 12, 0, 0).toISOString());
    expect(sent.json.payload.properties.__ip).toBe("127.0.0.1");
  });

  it("sends the install ID as the profile and a device ID made from it, so installs on one OS build do not merge", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await flush();
    const id = r.state().installId;
    expect(r.sent.length).toBeGreaterThan(1);
    for (const { json } of r.sent) expect(json.payload).toMatchObject({ profileId: id, properties: { __deviceId: `device-${id}` } });
  });

  it("sends the install's name on every event, and names the profile once", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await flush();
    const name = usernameOf(r.state().installId);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
    expect(r.sent.length).toBeGreaterThan(1);
    for (const { json } of r.sent) expect(json.payload.properties.username).toBe(name);
    expect(r.sent.map((s) => s.json.payload.properties.__identify)).toEqual([{ profileId: r.state().installId, firstName: name, properties: { username: name } }, ...r.sent.slice(1).map(() => undefined)]);
  });

  it("sends no request but events, on any install ID", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await flush();
    await r.telemetry.setEnabled(false, "settings");
    await r.telemetry.setEnabled(true, "settings");
    r.telemetry.track("tray_action", { action: "quit" });
    await flush();
    expect(r.sent.map((s) => s.json.type)).toEqual(r.sent.map(() => "track"));
    expect(new Set(r.sent.map((s) => s.json.payload.profileId)).size).toBe(2);
  });

  it("writes state and queue owner-only", () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    if (process.platform !== "win32") {
      expect(modeOf(r.file("telemetry.json"))).toBe(0o600);
      expect(modeOf(r.file("telemetry-queue.jsonl"))).toBe(0o600);
    }
  });

  it("drops what the schema does not allow, and applies the caps", () => {
    const r = ready();
    const t = r.telemetry;
    t.track("tray_action", { action: "open", path: "/Users/me" } as never);
    t.track("tray_action", { action: "rm -rf" } as never);
    t.track("not_an_event" as never, {} as never);
    t.track("app_launch", { launch_kind: "manual", boot_result: "ok" });
    t.track("app_launch", { launch_kind: "manual", boot_result: "ok" });
    expect(queued(r)).toEqual(["app_first_open", "tray_action", "app_launch"]);
    expect(r.queue()[1]!.p).not.toHaveProperty("path");
  });

  it("sends nothing for a person who has not got an install ID", async () => {
    const r = ready();
    await r.telemetry.setEnabled(false, "settings");
    await flush();
    expect(r.state().installId).toBeNull();
    r.telemetry.track("tray_action", { action: "open" });
    expect(queued(r)).toEqual([]);
  });
});

describe("app_first_open", () => {
  it("is fresh on a machine with no OpenLive home, and sends once", async () => {
    const r = ready();
    expect(r.queue()[0]).toMatchObject({ n: "app_first_open", p: { origin: "fresh", launch_kind: "manual" } });
    r.telemetry.onQuit();
    const second = r.again();
    second.telemetry.start({ launchKind: "manual" });
    expect(queued(second).filter((n) => n === "app_first_open")).toHaveLength(1);
  });

  it.each(["once.json", "window-state.json", "appearance.json", "../settings.json"])("is existing_install when %s was already there", (file) => {
    const dir = join(tmpDir(), "state");
    mkdirSync(dir);
    const r = rig({ stateDir: dir });
    r.touch(file);
    r.telemetry.start({ launchKind: "login" });
    notice(r.telemetry);
    expect(r.queue()[0]).toMatchObject({ n: "app_first_open", p: { origin: "existing_install", launch_kind: "login" } });
  });

  it("looks before main creates once.json, not after", () => {
    const r = rig();
    r.telemetry.start({ launchKind: "manual" });
    r.touch("once.json");
    notice(r.telemetry);
    expect(r.queue()[0]!.p.origin).toBe("fresh");
  });

  it("waits for the notice across runs, and still says how that first run began", () => {
    const first = rig();
    first.touch("appearance.json");
    first.telemetry.start({ launchKind: "login" });
    first.telemetry.onQuit("os_shutdown");
    const second = first.again();
    second.telemetry.start({ launchKind: "manual" });
    notice(second.telemetry);
    expect(second.queue().find((q) => q.n === "app_first_open")).toMatchObject({ p: { origin: "existing_install", launch_kind: "login" } });
  });

  it("is not sent again after telemetry is turned off and on", async () => {
    const r = ready();
    await flush();
    await r.telemetry.setEnabled(false, "settings");
    await flush();
    await r.telemetry.setEnabled(true, "settings");
    r.telemetry.track("tray_action", { action: "open" });
    await flush();
    expect(r.names().filter((n) => n === "app_first_open")).toHaveLength(1);
  });
});

describe("lifecycle events", () => {
  it("sends app_updated when the version differs from the last one seen, and not otherwise", () => {
    const first = ready();
    first.telemetry.onQuit();
    const same = first.again();
    same.telemetry.start();
    expect(queued(same)).not.toContain("app_updated");
    const next = first.again({ appVersion: "1.3.0" });
    next.telemetry.start();
    expect(next.queue().find((q) => q.n === "app_updated")).toMatchObject({ p: { from_version: "1.2.3", to_version: "1.3.0", app_version: "1.3.0" } });
  });

  it("sends app_active_day once per local day, across runs", () => {
    const r = ready();
    r.telemetry.markActiveDay("flow");
    r.telemetry.markActiveDay("call");
    expect(queued(r).filter((n) => n === "app_active_day")).toHaveLength(1);
    expect(r.queue().find((q) => q.n === "app_active_day")!.p.first_surface).toBe("flow");
    r.telemetry.onQuit();
    const again = r.again();
    again.telemetry.start();
    again.telemetry.markActiveDay("tray");
    expect(queued(again).filter((n) => n === "app_active_day")).toHaveLength(1);
    vi.setSystemTime(DAY_2);
    again.telemetry.markActiveDay("tray");
    expect(again.queue().filter((q) => q.n === "app_active_day").map((q) => q.p.first_surface)).toEqual(["flow", "tray"]);
  });

  it("puts a quit on disk synchronously, once, with the uptime", async () => {
    const r = ready();
    await flush(90 * 60_000);
    r.telemetry.onQuit("update_restart");
    r.telemetry.onQuit("tray_menu");
    const quits = r.queue().filter((q) => q.n === "app_quit");
    expect(quits).toHaveLength(1);
    expect(quits[0]!.p).toMatchObject({ via: "update_restart", uptime_h: 1.5 });
  });

  it("sends last run's quit at the next launch", async () => {
    const first = ready();
    await flush(120_000);
    first.telemetry.onQuit("tray_menu");
    const second = first.again();
    second.telemetry.start();
    await flush();
    expect(second.names()).toContain("app_quit");
  });

  it("reports a readiness change once, from the value reported before", () => {
    const r = ready();
    const t = r.telemetry;
    t.reportReadiness({ to: "access", perm_accessibility: false, perm_microphone: "denied", linux_session: "n/a" });
    t.reportReadiness({ to: "access", perm_accessibility: false });
    t.reportReadiness({ to: "ready", perm_accessibility: true });
    t.reportReadiness({ to: "bogus" } as never);
    const changes = r.queue().filter((q) => q.n === "flow_readiness_changed").map((q) => [q.p.from, q.p.to]);
    expect(changes).toEqual([["unknown", "access"], ["access", "ready"]]);
    r.telemetry.onQuit();
    const later = r.again();
    later.telemetry.start();
    later.telemetry.reportReadiness({ to: "ready" });
    expect(queued(later).filter((n) => n === "flow_readiness_changed")).toHaveLength(2);
  });

  it("sends an onboarding step once per install with the hours since first open", () => {
    const r = ready();
    vi.setSystemTime(new Date(DAY_1.getTime() + 90 * 60_000));
    r.telemetry.reportOnboardingStep("first_flow_summon");
    r.telemetry.reportOnboardingStep("first_flow_summon");
    r.telemetry.reportOnboardingStep("first_call");
    const steps = r.queue().filter((q) => q.n === "onboarding_step");
    expect(steps.map((s) => s.p.step)).toEqual(["first_flow_summon", "first_call"]);
    expect(steps[0]!.p.hours_since_first_open).toBe(1.5);
    r.telemetry.onQuit();
    const again = r.again();
    again.telemetry.start();
    again.telemetry.reportOnboardingStep("first_call");
    expect(queued(again).filter((n) => n === "onboarding_step")).toHaveLength(2);
  });
});

describe("feature counters", () => {
  it("counts only after the notice, ignores unknown keys, caps at 999, and sends the day's counts at quit without zeros", () => {
    const r = rig();
    r.telemetry.start();
    count(r.telemetry, "n_settings_open");
    notice(r.telemetry);
    count(r.telemetry, "n_palette_run");
    count(r.telemetry, "n_palette_run");
    count(r.telemetry, "n_typed_msg");
    count(r.telemetry, "n_typing_the_secret" as never);
    count(r.telemetry, "__proto__" as never);
    for (let i = 0; i < 1100; i++) count(r.telemetry, "n_camera_on");
    r.telemetry.onQuit("tray_menu");
    const usage = r.queue().find((q) => q.n === "feature_usage")!;
    expect(usage.p).toMatchObject({ n_palette_run: 2, n_typed_msg: 1, n_camera_on: 999 });
    expect(usage.p).not.toHaveProperty("n_settings_open");
    expect(Object.keys(usage.p).filter((k) => k.startsWith("n_")).sort()).toEqual(["n_camera_on", "n_palette_run", "n_typed_msg"]);
  });

  it("sends nothing when no feature was used", () => {
    const r = ready();
    r.telemetry.onQuit("tray_menu");
    expect(queued(r)).not.toContain("feature_usage");
  });

  it("sends a bucket a crash left behind at the next launch, once", async () => {
    const first = ready();
    count(first.telemetry, "n_history_open");
    await flush(5_000);
    const second = first.again();
    second.telemetry.start();
    expect(second.queue().find((q) => q.n === "feature_usage")!.p.n_history_open).toBe(1);
    second.telemetry.onQuit();
    const third = second.again();
    third.telemetry.start();
    expect(queued(third).filter((n) => n === "feature_usage")).toHaveLength(1);
  });
});

describe("Flow and call summaries", () => {
  it("folds agent and renderer facts into one flow_session and sends it", async () => {
    const r = ready();
    const t = r.telemetry;
    t.openFlow();
    t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "fact", scope: "flow", props: { brain_kind: "api", brain_id: "groq", turns: 2, t_insert: 1, ttft_ms: 420 } });
    t.handleRendererMessage({ t: "fact", scope: "flow_owner", props: { opened_by: "gesture", stops: 1 } });
    await flush(20_000);
    t.closeFlow("idle");
    await flush(200_000);
    const rec = r.sent.find((s) => s.json.payload.name === "flow_session")!.json.payload.properties;
    expect(rec).toMatchObject({
      brain_kind: "api", brain_id: "groq", turns: 2, t_insert: 1, acted: true, opened_by: "gesture", stops: 1,
      ttft_ms_p50: 420, ttft_ms_p95: 420, ended_by: "idle", duration_s: 20, app_version: "1.2.3",
    });
  });

  it("folds a call the same way and lets the renderer's reason stand", async () => {
    const r = ready();
    const t = r.telemetry;
    t.openCall();
    t.handleRendererMessage({ t: "fact", scope: "call_renderer", props: { ended_by: "orb_end", typed_turns: 1 } });
    t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "fact", scope: "call", props: { turns: 3, lang: "es" } });
    t.closeCall("window_closed");
    await flush(200_000);
    expect(r.sent.find((s) => s.json.payload.name === "call_session")!.json.payload.properties).toMatchObject({ turns: 3, lang: "es", typed_turns: 1, ended_by: "orb_end" });
  });

  it("emits an open record when the app quits", () => {
    const r = ready();
    r.telemetry.openFlow();
    r.telemetry.openCall();
    r.telemetry.onQuit("tray_menu");
    expect(r.queue().filter((q) => q.n.endsWith("_session")).map((q) => [q.n, q.p.ended_by])).toEqual([["flow_session", "quit"], ["call_session", "app_quit"]]);
  });

  it("emits nothing for a record opened after the person turned telemetry off", async () => {
    const r = ready();
    await r.telemetry.setEnabled(false, "settings");
    r.telemetry.openFlow();
    r.telemetry.closeFlow("gesture");
    await flush(200_000);
    expect(r.queue()).toEqual([]);
  });
});

describe("what an agent or a renderer may say", () => {
  const agent = (kind: string, rest: Record<string, unknown>) => ({ openlive: "telemetry", v: 1, kind, ...rest });

  it("takes the agent's own events, and nothing it has no business sending", () => {
    const r = ready();
    const t = r.telemetry;
    t.handleAgentMessage(agent("event", { name: "brain_error", props: { surface: "flow", class: "quota", brain_id: "openai" } }));
    t.handleAgentMessage(agent("event", { name: "voice_engine_fault", props: { engine_family: "piper", kind: "worker_crash" } }));
    t.handleAgentMessage(agent("event", { name: "flow_consent_result", props: { outcome: "granted" } }));
    t.handleAgentMessage(agent("event", { name: "voice_bench_result", props: { engine_family: "piper", engine_kind: "tts", chosen_provider: "cpu" } }));
    t.handleAgentMessage(agent("event", { name: "telemetry_disabled", props: { from: "notice", days_since_first_open: 1 } }));
    t.handleAgentMessage(agent("event", { name: "app_first_open", props: { origin: "fresh", launch_kind: "manual" } }));
    t.handleAgentMessage(agent("event", { name: "app_quit", props: { via: "other" } }));
    t.handleAgentMessage(agent("event", { name: "flow_session", props: { duration_s: 1, ended_by: "idle", turns: 1, acted: true } }));
    expect(queued(r)).toEqual(["app_first_open", "brain_error", "voice_engine_fault", "flow_consent_result", "voice_bench_result"]);
  });

  it("marks an agent's exception as the agent's, whatever it claims", () => {
    const r = ready();
    r.telemetry.handleAgentMessage(agent("event", { name: "main_exception", props: { process: "main", kind: "uncaught" } }));
    expect(r.queue().find((q) => q.n === "main_exception")!.p.process).toBe("agent");
  });

  it("takes only the onboarding steps that are the agent's", () => {
    const r = ready();
    const t = r.telemetry;
    const steps = ["first_agent_start_ok", "flow_consent_granted", "first_flow_reply", "first_call_reply", "activated"];
    for (const step of [...steps, "first_call", "tour_closed_home"]) t.handleAgentMessage(agent("event", { name: "onboarding_step", props: { step } }));
    expect(r.queue().filter((q) => q.n === "onboarding_step").map((q) => q.p.step)).toEqual(steps);
  });

  it("ignores what is not an agent message, and never throws", () => {
    const r = ready();
    const t = r.telemetry;
    const junk = [null, undefined, 5, "x", [], {}, { openlive: "other", v: 1 }, { openlive: "telemetry", v: 2, kind: "event" }, agent("weird", {}),
      agent("event", { name: "__proto__", props: {} }), agent("event", { name: "brain_error", props: null }), agent("fact", { scope: "__proto__", props: {} }),
      agent("fact", { scope: "agent_flow", props: { turns: 1 } }), agent("fact", { scope: "flow", props: "no" })];
    for (const m of junk) expect(() => t.handleAgentMessage(m)).not.toThrow();
    expect(queued(r)).toEqual(["app_first_open"]);
  });

  it("takes a renderer's events, facts, counters and notice, and no event that is main's", () => {
    const r = rig();
    const t = r.telemetry;
    t.start();
    t.handleRendererMessage({ t: "notice" });
    t.handleRendererMessage({ t: "track", name: "lobby_blocked", props: { gap: "no_mic" } });
    t.handleRendererMessage({ t: "track", name: "app_launch", props: { launch_kind: "manual", boot_result: "ok" } });
    t.handleRendererMessage({ t: "track", name: "telemetry_disabled", props: { from: "notice", days_since_first_open: 0 } });
    t.handleRendererMessage({ t: "track", name: "flow_session", props: {} });
    t.handleRendererMessage({ t: "count", key: "n_palette_open" });
    t.handleRendererMessage({ t: "fact", scope: "agent_flow", props: { turns: 9 } });
    t.handleRendererMessage({ t: "fact", scope: "flow_owner", props: { stops: 1 } });
    t.openFlow();
    t.handleRendererMessage({ t: "fact", scope: "flow_owner", props: { stops: 2 } });
    t.onQuit("tray_menu");
    expect(queued(r)).toEqual(["app_first_open", "lobby_blocked", "flow_session", "feature_usage", "app_quit"]);
    expect(r.queue().find((q) => q.n === "flow_session")!.p).toMatchObject({ stops: 3, turns: 0 });
  });

  it("never throws on garbage from a renderer", () => {
    const r = ready();
    const junk = [null, undefined, 3, "x", [], {}, { t: "track" }, { t: "track", name: {}, props: 1 }, { t: "fact", scope: "flow_owner", props: null }, { t: "count", key: {} }, { t: "nope" }];
    for (const m of junk) expect(() => r.telemetry.handleRendererMessage(m)).not.toThrow();
    expect(() => r.telemetry.track(undefined as never, undefined as never)).not.toThrow();
    expect(() => fact(r.telemetry, undefined as never, undefined as never)).not.toThrow();
    expect(() => count(r.telemetry, undefined as never)).not.toThrow();
    expect(() => r.telemetry.closeFlow(undefined as never)).not.toThrow();
    expect(() => r.telemetry.reportReadiness(undefined as never)).not.toThrow();
    expect(() => r.telemetry.markActiveDay(undefined as never)).not.toThrow();
  });
});

describe("turning telemetry off", () => {
  it("closes the gate and empties the queue at once, then sends one telemetry_disabled and forgets the ID", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    count(r.telemetry, "n_typed_msg");
    await flush(1_000);
    vi.setSystemTime(new Date(DAY_1.getTime() + 3.5 * 86_400_000));
    const id = r.state().installId;
    await r.telemetry.setEnabled(false, "settings");
    expect(r.state().enabled).toBe(false);
    r.telemetry.track("tray_action", { action: "quit" });
    r.telemetry.onQuit("tray_menu");
    await flush(200_000);
    const tracks = r.sent.filter((s) => s.json.type === "track");
    expect(tracks.map((s) => s.json.payload.name)).toEqual(["telemetry_disabled"]);
    expect(tracks[0]!.json.payload).toMatchObject({ profileId: id, properties: { from: "settings", days_since_first_open: 3, app_version: "1.2.3", username: usernameOf(id) } });
    expect(r.queue()).toEqual([]);
    expect(r.state()).toMatchObject({ installId: null, enabled: false, featureBucket: {} });
    expect(r.telemetry.getStatus()).toMatchObject({ enabled: false, installIdTail: "", username: "" });
  });

  it("gives up after three tries and leaves nothing on disk", async () => {
    const r = ready();
    await flush(200_000);
    r.post.mockClear();
    r.respond.fail = true;
    await r.telemetry.setEnabled(false, "notice");
    await flush(60_000);
    expect(r.post).toHaveBeenCalledTimes(3);
    expect(r.queue()).toEqual([]);
    expect(r.state().installId).toBeNull();
    await flush(3_600_000);
    expect(r.post).toHaveBeenCalledTimes(3);
  });

  it("does not fire when the notice was never shown, since nothing was ever on", async () => {
    const r = rig();
    r.telemetry.start();
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    expect(r.post).not.toHaveBeenCalled();
    expect(r.state()).toMatchObject({ enabled: false, installId: null });
  });

  it("fires once, however often it is asked", async () => {
    const r = ready();
    await r.telemetry.setEnabled(false, "settings");
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    expect(r.names().filter((n) => n === "telemetry_disabled")).toHaveLength(1);
  });

  it("stays off across a restart, and clears anything a crash left in the queue", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    const again = r.again();
    again.telemetry.start();
    notice(again.telemetry);
    again.telemetry.track("tray_action", { action: "open" });
    again.telemetry.onQuit("tray_menu");
    await flush(200_000);
    expect(again.post).not.toHaveBeenCalled();
    expect(again.queue()).toEqual([]);
    expect(again.telemetry.getStatus()).toMatchObject({ enabled: false });
  });

  it("turns back on with a fresh install ID and no second app_first_open", async () => {
    const r = ready();
    await flush(200_000);
    const before = r.state().installId;
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    r.post.mockClear();
    await r.telemetry.setEnabled(true, "settings");
    const after = r.state().installId;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    r.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    const calls = r.post.mock.calls.map((c) => JSON.parse(c[0].body));
    expect(calls.map((c) => c.type)).toEqual(["track"]);
    expect(calls[0].payload).toMatchObject({ name: "tray_action", profileId: after });
  });

  it("does not delete the new ID when it is turned back on while the last event is still going out", async () => {
    const r = ready({ sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    await flush(200_000);
    r.respond.fail = true;
    await r.telemetry.setEnabled(false, "settings");
    await flush(1);
    expect(r.state().installId).toBeTruthy();
    await r.telemetry.setEnabled(true, "settings");
    const id = r.state().installId;
    await flush(60_000);
    expect(r.state()).toMatchObject({ enabled: true, installId: id });
  });
});

describe("turning sharing off and on", () => {
  it("re-arms the once-only events under the new install ID", async () => {
    const r = ready();
    r.telemetry.reportOnboardingStep("first_call");
    await flush(200_000);
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    await r.telemetry.setEnabled(true, "settings");
    r.post.mockClear();
    r.telemetry.reportOnboardingStep("first_call");
    await flush(200_000);
    const calls = r.post.mock.calls.map((c) => JSON.parse(c[0].body));
    expect(calls.map((c) => c.payload.name)).toEqual(["onboarding_step"]);
    expect(calls[0].payload.profileId).toBe(r.state().installId);
    expect(r.sent.filter((s) => s.json.payload.name === "app_first_open")).toHaveLength(1);
  });

  it("gives a new name with the new ID, and sends it with the first event under it", async () => {
    const r = ready();
    r.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    const before = r.telemetry.getStatus().username;
    expect(before).toBe(usernameOf(r.state().installId));
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    await r.telemetry.setEnabled(true, "settings");
    const after = r.telemetry.getStatus().username;
    expect(after).toBe(usernameOf(r.state().installId));
    expect(after).not.toBe(before);
    r.sent.length = 0;
    r.telemetry.track("tray_action", { action: "quit" });
    await flush(200_000);
    expect(r.sent[0]!.json.payload.properties).toMatchObject({ username: after, __identify: { firstName: after } });
  });
});

describe("status", () => {
  it("shows the last four characters of the ID and the facts a person can check", () => {
    const r = ready();
    const s = r.telemetry.getStatus();
    expect(s).toEqual({ active: true, enabled: true, noticeSeen: true, installIdTail: r.state().installId.slice(-4), username: usernameOf(r.state().installId), feedback: true, appVersion: "1.2.3", osName: "macOS", osMajor: "15" });
    expect(s.installIdTail).toHaveLength(4);
  });

  it("names the OS in words", () => {
    expect(rig({ platform: "win32", osMajor: "11" }).telemetry.getStatus()).toMatchObject({ osName: "Windows", osMajor: "11" });
    expect(rig({ platform: "linux", osMajor: "linux" }).telemetry.getStatus()).toMatchObject({ osName: "Linux" });
  });
});

describe("a quit before the notice", () => {
  const launch = (r: ReturnType<typeof rig>) => {
    r.telemetry.start({ launchKind: "manual" });
    r.telemetry.markActiveDay("flow");
    r.telemetry.reportReadiness({ to: "ready" });
  };

  it("loses none of the day's events, and marks them as reported only once they were queued", () => {
    const first = rig();
    first.telemetry.start({ launchKind: "manual" });
    first.telemetry.onQuit("tray_menu");
    const second = first.again({ appVersion: "1.3.0" });
    launch(second);
    second.telemetry.onQuit("tray_menu");
    expect(second.queue()).toEqual([]);

    const third = second.again({ appVersion: "1.3.0" });
    launch(third);
    notice(third.telemetry);
    expect(queued(third)).toEqual(["app_first_open", "app_updated", "app_active_day", "flow_readiness_changed"]);
    expect(third.queue().find((q) => q.n === "app_updated")!.p).toMatchObject({ from_version: "1.2.3", to_version: "1.3.0" });
    expect(third.queue().find((q) => q.n === "flow_readiness_changed")!.p).toMatchObject({ from: "unknown", to: "ready" });
    third.telemetry.onQuit("tray_menu");

    const fourth = third.again({ appVersion: "1.3.0" });
    launch(fourth);
    expect(queued(fourth).filter((n) => ["app_updated", "app_active_day", "flow_readiness_changed"].includes(n))).toHaveLength(3);
  });

  it("does not report a readiness change twice in one run, held or not", () => {
    const r = rig();
    r.telemetry.start();
    r.telemetry.reportReadiness({ to: "access" });
    r.telemetry.reportReadiness({ to: "access" });
    r.telemetry.markActiveDay("tray");
    r.telemetry.markActiveDay("flow");
    notice(r.telemetry);
    expect(queued(r).filter((n) => n === "flow_readiness_changed" || n === "app_active_day")).toHaveLength(2);
  });
});

describe("feature counters and the daily cap", () => {
  const usage = (r: ReturnType<typeof rig>) => r.queue().filter((q) => q.n === "feature_usage");

  it("keeps the counts a full day turned away, and sends them the next day", () => {
    let r = ready();
    for (let quit = 0; quit < 5; quit++) {
      count(r.telemetry, "n_palette_run");
      r.telemetry.onQuit("tray_menu");
      r = r.again();
      r.telemetry.start();
    }
    expect(usage(r).map((q) => q.p.n_palette_run)).toEqual([1, 1, 1]);
    vi.setSystemTime(DAY_2);
    const next = r.again();
    next.telemetry.start();
    expect(usage(next).map((q) => q.p.n_palette_run)).toEqual([1, 1, 1, 2]);
  });

  it("stamps a day's counts with the minute they were last counted, not the day they were sent", () => {
    const r = ready();
    count(r.telemetry, "n_palette_run");
    const lastCounted = DAY_1.getTime() + 90 * 60_000;
    vi.setSystemTime(lastCounted);
    count(r.telemetry, "n_palette_run");
    vi.setSystemTime(DAY_2);
    count(r.telemetry, "n_typed_msg");
    expect(usage(r).map((q) => q.t)).toEqual([new Date(lastCounted).toISOString()]);
  });

  it("sends a day's counts when the first count of the next day arrives", () => {
    const r = ready();
    count(r.telemetry, "n_palette_run");
    count(r.telemetry, "n_palette_run");
    vi.setSystemTime(DAY_2);
    count(r.telemetry, "n_typed_msg");
    expect(usage(r)).toHaveLength(1);
    expect(usage(r)[0]!.p).toMatchObject({ n_palette_run: 2 });
    expect(usage(r)[0]!.p).not.toHaveProperty("n_typed_msg");
    r.telemetry.onQuit("tray_menu");
    expect(usage(r).map((q) => q.p.n_typed_msg)).toEqual([undefined, 1]);
  });
});

describe("numbers we compute", () => {
  const sentProps = (r: ReturnType<typeof rig>, name: string) => r.sent.find((s) => s.json.payload.name === name)?.json.payload.properties;
  const YEAR = 365 * 86_400_000;

  it("sends a Flow record open for 30 hours as a day-long one, and a call the same", async () => {
    const r = ready();
    r.telemetry.openFlow();
    r.telemetry.openCall();
    await flush(30 * 3_600_000);
    r.telemetry.closeFlow("idle");
    r.telemetry.closeCall("end_button");
    await flush(200_000);
    expect(sentProps(r, "flow_session")).toMatchObject({ duration_s: 86_400, ended_by: "idle" });
    expect(sentProps(r, "call_session")).toMatchObject({ duration_s: 86_400, ended_by: "end_button" });
  });

  it("sends a three year old install's opt-out as 999 days, and a clock set back as 0", async () => {
    const r = ready();
    await flush(200_000);
    vi.setSystemTime(new Date(DAY_1.getTime() + 3 * YEAR));
    await r.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    expect(sentProps(r, "telemetry_disabled")).toMatchObject({ days_since_first_open: 999 });

    const back = ready();
    vi.setSystemTime(new Date(DAY_1.getTime() - 5 * 86_400_000));
    await back.telemetry.setEnabled(false, "settings");
    await flush(200_000);
    expect(sentProps(back, "telemetry_disabled")).toMatchObject({ days_since_first_open: 0 });
  });

  it("pins uptime and the hours since first open to their caps, and does not drop the event", () => {
    const r = ready();
    vi.setSystemTime(new Date(DAY_1.getTime() + 12 * YEAR));
    r.telemetry.reportOnboardingStep("first_call");
    r.telemetry.onQuit("tray_menu");
    expect(r.queue().find((q) => q.n === "onboarding_step")!.p.hours_since_first_open).toBe(99_999);
    expect(r.queue().find((q) => q.n === "app_quit")!.p).toMatchObject({ via: "tray_menu", uptime_h: 999 });
  });
});

describe("a state or queue file that was edited", () => {
  it("makes a new install ID when the stored one is not a UUID, without sending app_first_open again", async () => {
    const first = ready();
    await flush(200_000);
    writeFileSync(first.file("telemetry.json"), JSON.stringify({ ...first.state(), installId: "../../not-a-uuid" }));
    const second = first.again();
    second.telemetry.start();
    second.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    const id = second.state().installId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.names()).toEqual(["tray_action"]);
    expect(second.sent[0]!.json.payload.profileId).toBe(id);
  });

  it("sends only what the schema allows from a planted queue line", async () => {
    const dir = tmpDir();
    const line = { n: "tray_action", p: { app_version: "1.2.3", action: "open", path: "/Users/me/secret", note: "hi" }, t: "2026-09-29T12:00:00.000Z" };
    writeFileSync(join(dir, "telemetry-queue.jsonl"), `${JSON.stringify(line)}\n${JSON.stringify({ n: "made_up", p: {}, t: "2026-09-29T12:00:00.000Z" })}\n`);
    const r = rig({ stateDir: dir });
    r.telemetry.start({ launchKind: "manual" });
    notice(r.telemetry);
    await flush(200_000);
    expect(r.names()).toEqual(["tray_action", "app_first_open"]);
    const id = r.state().installId;
    expect(r.sent[0]!.json.payload.properties).toEqual({
      app_version: "1.2.3", username: usernameOf(id), action: "open", __timestamp: "2026-09-29T12:00:00.000Z", __ip: "127.0.0.1",
      __deviceId: `device-${id}`, __identify: { profileId: id, firstName: usernameOf(id), properties: { username: usernameOf(id) } },
    });
    expect(r.queue()).toEqual([]);
  });
});

describe("turning sharing off, as the screen sees it", () => {
  it("shows the ID and the name gone at once, without waiting for the last event to be sent", async () => {
    const post = vi.fn(() => new Promise(() => {}));
    const r = ready({ post });
    expect(r.telemetry.getStatus()).toMatchObject({ enabled: true, installIdTail: expect.stringMatching(/^.{4}$/), username: expect.stringContaining("-") });
    await r.telemetry.setEnabled(false, "settings");
    expect(r.telemetry.getStatus()).toMatchObject({ enabled: false, installIdTail: "", username: "" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("shows a new ID and name once it is turned back on", async () => {
    const r = ready();
    await r.telemetry.setEnabled(false, "settings");
    await flush(10_000);
    await r.telemetry.setEnabled(true, "settings");
    expect(r.telemetry.getStatus()).toMatchObject({ enabled: true, installIdTail: expect.stringMatching(/^.{4}$/), username: expect.stringContaining("-") });
  });
});

describe("an opt-out the disk would not take", () => {
  const failing = (broken: { on: boolean }) => ({
    ...nodeFs,
    writeFileSync: (f: string, ...rest: unknown[]) => {
      if (broken.on && String(f).includes("telemetry.json")) throw new Error("ENOSPC");
      return (nodeFs.writeFileSync as (...a: unknown[]) => void)(f, ...rest);
    },
  });

  it("stays off at the next launch, sends nothing, and is turned on again only by the person", async () => {
    const broken = { on: false };
    const r = ready({ fs: failing(broken) });
    await flush(200_000);
    broken.on = true;
    await r.telemetry.setEnabled(false, "settings");
    expect(r.state().enabled).toBe(true);
    expect(existsSync(r.file("telemetry-off"))).toBe(true);
    broken.on = false;
    r.telemetry.onQuit("tray_menu");

    const again = r.again({ fs: nodeFs });
    again.telemetry.start({ launchKind: "manual" });
    notice(again.telemetry);
    again.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    expect(again.telemetry.getStatus()).toMatchObject({ enabled: false, installIdTail: "", username: "" });
    expect(again.post).not.toHaveBeenCalled();
    expect(again.state()).toMatchObject({ enabled: false, installId: null });

    await again.telemetry.setEnabled(true, "settings");
    expect(existsSync(again.file("telemetry-off"))).toBe(false);
    expect(again.state().enabled).toBe(true);
    expect(again.telemetry.getStatus().enabled).toBe(true);
  });

  it("does not show the first-run notice, and queues nothing, while sharing is off", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "telemetry-off"), "");
    const r = rig({ stateDir: dir });
    r.telemetry.start({ launchKind: "manual" });
    notice(r.telemetry);
    r.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    expect(r.telemetry.getStatus()).toMatchObject({ active: true, enabled: false, noticeSeen: false });
    expect(r.post).not.toHaveBeenCalled();
    expect(r.queue()).toEqual([]);
    expect(r.state().noticeSeenAt).toBeNull();
  });
});

describe("a telemetry.json that cannot be read", () => {
  it("does not report a second first open for an install that already did, and shows the notice again", async () => {
    const first = ready();
    await flush(200_000);
    expect(first.names()).toContain("app_first_open");
    first.telemetry.onQuit("tray_menu");
    first.touch("once.json");
    writeFileSync(first.file("telemetry.json"), '{"v":1,"installId":"0a1b2c3d-00');

    const again = first.again();
    again.telemetry.start({ launchKind: "manual" });
    expect(again.telemetry.getStatus().noticeSeen).toBe(false);
    notice(again.telemetry);
    await flush(200_000);
    expect(again.names()).not.toContain("app_first_open");
    expect(again.state().firstOpenAt).not.toBeNull();
  });
});

describe("a quit that did not happen", () => {
  it("resumes sending, the announced quit included", async () => {
    const r = ready();
    await flush(200_000);
    r.telemetry.onQuit("update_restart");
    r.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    expect(r.names()).not.toContain("tray_action");
    r.telemetry.resume();
    await flush(200_000);
    expect(r.names()).toEqual(expect.arrayContaining(["tray_action", "app_quit"]));
  });

  it("does nothing when no quit was announced", async () => {
    const r = ready();
    await flush(200_000);
    r.post.mockClear();
    r.telemetry.resume();
    r.telemetry.track("tray_action", { action: "open" });
    await flush(200_000);
    expect(r.post).toHaveBeenCalledTimes(1);
  });
});
