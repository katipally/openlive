import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { DAY_1 } from "./rig";

const require = createRequire(import.meta.url);
const { createAggregator, EARLY_MS, GRACE_MS } = require("./aggregator.cjs");
const { validateEvent } = require("./validate.cjs");
const schema = require("./schema.json");

const timers = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: NodeJS.Timeout) => clearTimeout(t) };

function make(over: { schema?: unknown; random?: () => number } = {}) {
  const emitted: { name: string; props: Record<string, any> }[] = [];
  const agg = createAggregator({
    schema: over.schema ?? schema, now: Date.now, random: over.random ?? (() => 0.5), timers,
    emit: (name: string, props: Record<string, any>) => emitted.push({ name, props }),
  });
  return { agg, emitted, last: () => emitted.at(-1)!.props };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers({ now: DAY_1 }));
afterEach(() => vi.useRealTimers());

describe("folding a Flow record", () => {
  it("folds facts from the agent and the owner into one flow_session at close", async () => {
    const { agg, emitted, last } = make();
    agg.openFlow();
    agg.fact("agent_flow", { brain_kind: "acp", brain_id: "codex", turns: 1, tool_calls: 2, t_see: 1, ttft_ms: 400, turn_ms: 2100 });
    agg.fact("flow_owner", { opened_by: "gesture", stops: 1, ready: "ok", ready_ms: 240 });
    await tick(30_000);
    agg.fact("agent_flow", { turns: 2, tool_calls: 1, t_insert: 1, brain_id: "claude-code", ttft_ms: 600, turn_ms: 1900 });
    agg.closeFlow("orb_button");
    expect(emitted).toHaveLength(0);
    await tick(GRACE_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe("flow_session");
    expect(last()).toEqual({
      brain_kind: "acp", brain_id: "claude-code", turns: 3, tool_calls: 3, t_see: 1, t_insert: 1, acted: true,
      opened_by: "gesture", stops: 1, ready: "ok", ready_ms: 240,
      ttft_ms_p50: 400, ttft_ms_p95: 600, turn_ms_p50: 1900,
      duration_s: 30, ended_by: "orb_button",
    });
  });

  it("emits a session with no facts as a quiet one: zero turns, not acted, and the times", async () => {
    const { agg, last } = make();
    agg.openFlow();
    await tick(4_000);
    agg.closeFlow("gesture");
    await tick(GRACE_MS);
    expect(last()).toEqual({ turns: 0, acted: false, duration_s: 4, ended_by: "gesture" });
  });

  it("derives acted from the tools that change something, and only those", async () => {
    for (const [prop, acted] of [["t_insert", true], ["t_keys", true], ["t_point", true], ["t_window", true], ["t_open", true], ["t_shell", true], ["t_see", false], ["t_words", false], ["t_memory", false]] as const) {
      const { agg, last } = make();
      agg.openFlow();
      agg.fact("agent_flow", { [prop]: 2 });
      agg.closeFlow("idle");
      await tick(GRACE_MS);
      expect(last().acted, prop).toBe(acted);
    }
  });

  it("produces events the validator accepts, rounding latencies to its steps", async () => {
    const { agg, last } = make();
    agg.openFlow();
    agg.fact("agent_flow", { turns: 4, ttft_ms: 347, agent_start_ms: 1204, perm_asks: 2, perm_allowed: 1 });
    agg.fact("flow_owner", { webgpu: true, stt_family: "parakeet", last_failure: "offline" });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(validateEvent("flow_session", last())).toMatchObject({ turns: 4, ttft_ms_p50: 350, ttft_ms_p95: 350, agent_start_ms: 1200, perm_asks: 2 });
  });
});

describe("fold rules", () => {
  it("sums, and caps a sum at the event's cap", async () => {
    const { agg, last } = make();
    agg.openFlow();
    agg.fact("agent_flow", { turns: 600, steered: 1 });
    agg.fact("agent_flow", { turns: 600, steered: 2 });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last()).toMatchObject({ turns: 999, steered: 3 });
  });

  it("keeps the newest of a last, and stays true once an or was true", async () => {
    const { agg, last } = make();
    agg.openCall();
    agg.fact("agent_call", { lang: "es", camera_used: true, resumed: "loaded" });
    agg.fact("agent_call", { lang: "fr", camera_used: false });
    agg.fact("call_renderer", { camera_used: false, screen_used: false, has_folder: true });
    agg.fact("call_renderer", { has_folder: false });
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last()).toMatchObject({ lang: "fr", camera_used: true, screen_used: false, has_folder: false, resumed: "loaded" });
  });

  it("keeps the largest of a max", async () => {
    const custom = structuredClone(schema);
    custom.facts.agent_flow.props.steered.fold = "max";
    const { agg, last } = make({ schema: custom });
    agg.openFlow();
    for (const n of [3, 9, 4]) agg.fact("agent_flow", { steered: n });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last().steered).toBe(9);
  });

  it("emits median and 95th percentile of samples, and only the percentiles a prop names", async () => {
    const { agg, last } = make();
    agg.openFlow();
    for (const ms of [1000, 100, 300, 200, 400, 500, 600, 700, 800, 900]) agg.fact("agent_flow", { ttft_ms: ms, turn_ms: ms * 2 });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last()).toMatchObject({ ttft_ms_p50: 500, ttft_ms_p95: 1000, turn_ms_p50: 1000 });
    expect(last()).not.toHaveProperty("turn_ms_p95");
  });

  it("gives a single sample as both percentiles", async () => {
    const { agg, last } = make();
    agg.openCall();
    agg.fact("agent_call", { ttft_ms: 250 });
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last()).toMatchObject({ ttft_ms_p50: 250, ttft_ms_p95: 250 });
  });

  it("keeps memory flat and percentiles fair over a very long record", async () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const { agg, last } = make({ random });
    agg.openFlow();
    for (let i = 0; i < 20_000; i++) agg.fact("agent_flow", { ttft_ms: i % 10_000 });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last().ttft_ms_p50).toBeGreaterThan(4_000);
    expect(last().ttft_ms_p50).toBeLessThan(6_000);
    expect(last().ttft_ms_p95).toBeGreaterThan(8_800);
  });

  it("ignores props and scopes it does not fold", async () => {
    const { agg, last } = make();
    agg.openFlow();
    agg.fact("agent_flow", { nope: 1, path: "/x", stops: 4 });
    agg.fact("call_renderer", { typed_turns: 3 });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last()).toEqual({ turns: 0, acted: false, duration_s: 0, ended_by: "idle" });
  });
});

describe("when a fact arrives", () => {
  it("holds one that comes before the record opens, for up to 10 seconds", async () => {
    const { agg, last } = make();
    agg.fact("agent_call", { turns: 1, brain_id: "groq" });
    await tick(EARLY_MS - 1_000);
    agg.openCall();
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last()).toMatchObject({ turns: 1, brain_id: "groq" });
  });

  it("drops one that waited longer than that", async () => {
    const { agg, last } = make();
    agg.fact("agent_call", { turns: 1 });
    await tick(EARLY_MS + 1_000);
    agg.openCall();
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last().turns).toBe(0);
  });

  it("keeps an early fact for the record of its own kind, not the other", async () => {
    const { agg, last } = make();
    agg.fact("agent_flow", { turns: 5 });
    agg.openCall();
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last().turns).toBe(0);
    agg.openFlow();
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last().turns).toBe(5);
  });

  it("holds a bounded number of early facts", async () => {
    const { agg, last } = make();
    for (let i = 0; i < 500; i++) agg.fact("agent_flow", { turns: 1 });
    agg.openFlow();
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(last().turns).toBeLessThanOrEqual(64);
  });

  it("folds a straggler that lands within 2 seconds of the close signal", async () => {
    const { agg, emitted, last } = make();
    agg.openFlow();
    agg.closeFlow("gesture");
    await tick(1_500);
    agg.fact("flow_owner", { stops: 2 });
    await tick(600);
    expect(emitted).toHaveLength(1);
    expect(last().stops).toBe(2);
  });

  it("does not fold one that lands after the summary went out", async () => {
    const { agg, emitted } = make();
    agg.openFlow();
    agg.closeFlow("gesture");
    await tick(GRACE_MS + 500);
    agg.fact("flow_owner", { stops: 2 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.props).not.toHaveProperty("stops");
  });
});

describe("opening and closing", () => {
  it("measures the duration to the close signal, not to the summary", async () => {
    const { agg, last } = make();
    agg.openCall();
    await tick(90_000);
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last().duration_s).toBe(90);
  });

  it("never reports a negative duration", async () => {
    const { agg, last } = make();
    agg.openCall();
    vi.setSystemTime(DAY_1.getTime() - 60_000);
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    expect(last().duration_s).toBe(0);
  });

  it("pins a record open over a day to the day, so the summary is still sent", async () => {
    for (const [open, close, event] of [["openFlow", "closeFlow", "flow_session"], ["openCall", "closeCall", "call_session"]] as const) {
      const { agg, emitted, last } = make();
      agg[open]();
      agg.fact(event === "flow_session" ? "agent_flow" : "agent_call", { turns: 2 });
      await tick(30 * 3_600_000);
      agg[close]("idle");
      await tick(GRACE_MS);
      expect(emitted).toHaveLength(1);
      expect(last().duration_s).toBe(schema.events[event].props.duration_s.max);
      expect(validateEvent(event, last())).toMatchObject({ duration_s: 86_400, turns: 2 });
    }
  });

  it("emits the closing record at once when the next one opens", async () => {
    const { agg, emitted } = make();
    agg.openFlow();
    agg.fact("agent_flow", { turns: 1 });
    agg.closeFlow("gesture");
    agg.openFlow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.props).toMatchObject({ turns: 1, ended_by: "gesture" });
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.props.turns).toBe(0);
  });

  it("closes a record that was never closed when a new one opens", () => {
    const { agg, emitted } = make();
    agg.openCall();
    agg.openCall();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.props.ended_by).toBe("other");
  });

  it("emits once however many times the close arrives, and nothing for a close with no record", async () => {
    const { agg, emitted } = make();
    agg.closeFlow("gesture");
    agg.openFlow();
    agg.closeFlow("gesture");
    agg.closeFlow("idle");
    await tick(GRACE_MS * 3);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.props.ended_by).toBe("gesture");
  });

  it("keeps a Flow record and a call record apart", async () => {
    const { agg, emitted } = make();
    agg.openFlow();
    agg.openCall();
    agg.fact("agent_flow", { turns: 1 });
    agg.fact("agent_call", { turns: 7 });
    agg.closeCall("end_button");
    await tick(GRACE_MS);
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(emitted.map((e) => [e.name, e.props.turns])).toEqual([["call_session", 7], ["flow_session", 1]]);
  });
});

describe("ended_by", () => {
  const endedBy = async (facts: Record<string, unknown> | null, reason: string, kind: "flow" | "call" = "call") => {
    const { agg, last } = make();
    kind === "call" ? agg.openCall() : agg.openFlow();
    if (facts) agg.fact("call_renderer", facts);
    kind === "call" ? agg.closeCall(reason) : agg.closeFlow(reason);
    await tick(GRACE_MS);
    return last().ended_by;
  };

  it("takes the renderer's reason for a call, and main's when the renderer said none", async () => {
    expect(await endedBy({ ended_by: "orb_end" }, "window_closed")).toBe("orb_end");
    expect(await endedBy(null, "window_closed")).toBe("window_closed");
  });

  it("lets the app quitting override whatever the renderer said", async () => {
    expect(await endedBy({ ended_by: "end_button" }, "app_quit")).toBe("app_quit");
    expect(await endedBy(null, "quit", "flow")).toBe("quit");
  });

  it("falls back to other for a reason outside the set", async () => {
    expect(await endedBy(null, "the user was bored")).toBe("other");
    expect(await endedBy(null, undefined as unknown as string)).toBe("other");
    expect(await endedBy(null, "link_lost")).toBe("other");
    expect(await endedBy(null, "sleep", "flow")).toBe("other");
    expect(await endedBy(null, "sleep_or_lock", "flow")).toBe("sleep_or_lock");
  });
});

describe("quit and discard", () => {
  it("flushes what is open on quit, with the quit reasons, and what is already closing", async () => {
    const { agg, emitted } = make();
    agg.openFlow();
    agg.openCall();
    agg.fact("agent_call", { turns: 2 });
    await tick(5_000);
    agg.flush();
    expect(emitted.map((e) => [e.name, e.props.ended_by, e.props.duration_s])).toEqual([["flow_session", "quit", 5], ["call_session", "app_quit", 5]]);
    await tick(GRACE_MS * 2);
    expect(emitted).toHaveLength(2);
    const other = make();
    other.agg.openFlow();
    other.agg.closeFlow("gesture");
    other.agg.flush();
    expect(other.emitted.map((e) => e.props.ended_by)).toEqual(["gesture"]);
  });

  it("flushes nothing when nothing is open", () => {
    const { agg, emitted } = make();
    agg.flush();
    expect(emitted).toEqual([]);
  });

  it("forgets everything on discard: open records, closing ones and held facts", async () => {
    const { agg, emitted } = make();
    agg.fact("agent_flow", { turns: 1 });
    agg.openCall();
    agg.openFlow();
    agg.closeFlow("gesture");
    agg.discard();
    await tick(GRACE_MS * 2);
    agg.flush();
    expect(emitted).toEqual([]);
    agg.openFlow();
    agg.closeFlow("idle");
    await tick(GRACE_MS);
    expect(emitted[0]!.props.turns).toBe(0);
  });
});
