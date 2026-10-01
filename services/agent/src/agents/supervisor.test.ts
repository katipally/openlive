// The supervisor makes external agents safe to ship: a hung or crashed agent
// process must end as a SPOKEN error, never a session stuck listening.
import assert from "node:assert";
import { test } from "vitest";
import { AgentSupervisor } from "./supervisor.ts";
import { limits } from "../telemetry/limits.ts";

const agent = (over: object) => ({ id: "claude-code" as const, start: async () => {}, seed: () => {}, runTurn: async () => {}, dispose: async () => {}, ...over });
const collect = () => { const events: any[] = []; return { events, emit: (e: any) => { events.push(e); } }; };
const noAsk = async () => "deny"; // the supervisor's askPermission arg — unused in these turns

test("a start that never resolves rejects on the deadline instead of hanging forever", async () => {
  const sup = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}) }) as any, noAsk, { startMs: 50 });
  await assert.rejects(sup.start(new AbortController().signal), /didn't become ready/);
});

test("a start that fails or times out disposes the agent, so no adapter process is left running", async () => {
  let disposed = 0;
  const failing = new AgentSupervisor(() => agent({ start: async () => { throw new Error("no"); }, dispose: async () => { disposed++; } }) as any, noAsk);
  await assert.rejects(failing.start(new AbortController().signal), /no/);
  const hung = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}), dispose: async () => { disposed++; } }) as any, noAsk, { startMs: 50 });
  await assert.rejects(hung.start(new AbortController().signal), /didn't become ready/);
  assert.equal(disposed, 2);
});

test("a restart whose start fails disposes the new agent too", async () => {
  const disposed: number[] = [];
  let built = 0;
  const sup = new AgentSupervisor(() => {
    const n = ++built;
    return agent({
      start: async () => { if (n > 1) throw new Error("still broken"); },
      runTurn: async () => { throw new Error("boom"); },
      dispose: async () => { disposed.push(n); },
    }) as any;
  }, noAsk);
  await sup.start(new AbortController().signal);
  const { events, emit } = collect();
  await sup.runTurn({ text: "hi", frames: [] }, emit, new AbortController().signal);
  assert.deepEqual(disposed, [1, 2]);
  assert.ok(events.some((e) => e.type === "error" && /installed and signed in/.test(e.message)));
});

test("a crashed turn ends as a spoken recovery notice and recycles ONCE", async () => {
  let built = 0;
  const sup = new AgentSupervisor(() => { built++; return agent({ runTurn: async () => { throw new Error("boom"); } }) as any; }, noAsk);
  const { events, emit } = collect();
  await sup.runTurn({ text: "hi", frames: [] }, emit, new AbortController().signal);
  // The recovery notice is an out-of-band error event (client speaks it via engine.say +
  // shows a banner), never a text_delta concatenated into and persisted as the agent's reply.
  assert.ok(events.some((e) => e.type === "error" && /restarted/i.test(e.message)), "spoken recovery, not dead air");
  assert.equal(events.filter((e) => e.type === "text_delta").length, 0, "no ghost text in the reply");
  assert.equal(built, 2, "restart-once fired");
  await sup.runTurn({ text: "again", frames: [] }, emit, new AbortController().signal);
  assert.equal(built, 2, "restart budget already spent");
});

test("barge-in (parent signal abort) is NOT a failure — no error events", async () => {
  const parent = new AbortController();
  const sup = new AgentSupervisor(() => agent({ runTurn: (_i: unknown, _e: unknown, signal: AbortSignal) => new Promise<void>((res) => signal.addEventListener("abort", () => res())) }) as any, noAsk);
  const { events, emit } = collect();
  const turn = sup.runTurn({ text: "hi", frames: [] }, emit, parent.signal);
  setTimeout(() => parent.abort(), 20);
  await turn;
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("restart-seed history stays bounded: entry count capped, oversized turns clipped", async () => {
  const big = "x".repeat(10_000);
  let crash = false;
  let seeded: { role: string; text: string }[] = [];
  const sup = new AgentSupervisor(() => agent({
    seed: (h: { role: string; text: string }[]) => { seeded = h; },
    runTurn: async (_i: unknown, emit: (e: unknown) => void) => {
      if (crash) throw new Error("boom");
      emit({ type: "text_delta", text: big });
    },
  }) as any, noAsk);
  const { emit } = collect();
  for (let i = 0; i < 25; i++) await sup.runTurn({ text: big, frames: [] }, emit, new AbortController().signal); // 50 entries pushed
  crash = true;
  await sup.runTurn({ text: "last", frames: [] }, emit, new AbortController().signal); // recycle → seed(history)
  assert.ok(seeded.length <= 40, `history capped (got ${seeded.length})`);
  assert.ok(seeded.every((m) => m.text.length <= 4097), "every entry clipped to ~4KB");
});

test("a cut reaches the running agent and the history a restarted one is seeded with", async () => {
  let crash = false;
  const cuts: string[] = [];
  let seeded: { role: string; text: string }[] = [];
  const sup = new AgentSupervisor(() => agent({
    seed: (h: { role: string; text: string }[]) => { seeded = h; },
    cut: (s: string) => { cuts.push(s); },
    runTurn: async (_i: unknown, emit: (e: unknown) => void) => {
      if (crash) throw new Error("boom");
      emit({ type: "text_delta", text: "One. Two. Three." });
    },
  }) as any, noAsk);
  const { emit } = collect();
  await sup.runTurn({ text: "Count.", frames: [] }, emit, new AbortController().signal);
  sup.cut(" One. ");
  assert.deepEqual(cuts, [" One. "]);
  crash = true;
  await sup.runTurn({ text: "Go on.", frames: [] }, emit, new AbortController().signal);
  assert.deepEqual(seeded, [{ role: "user", text: "Count." }, { role: "assistant", text: "One." }]);
});

// What the supervisor reports, and to which session: the incident with whether the restart worked, and each restart.
const reporting = async (run: (sent: any[]) => Promise<void>) => {
  const sent: any[] = [];
  (process as any).parentPort = { postMessage: (m: unknown) => sent.push(m) };
  limits.clear();
  try { await run(sent); } finally { delete (process as any).parentPort; }
};
const brainErrors = (sent: any[]) => sent.filter((m) => m.name === "brain_error").map((m) => m.props);
const restarts = (sent: any[]) => sent.filter((m) => m.kind === "fact" && m.props.agent_restarts).length;

test("a crash is reported as recovered when the restart took, and the notice carries the same class", () => reporting(async (sent) => {
  const sup = new AgentSupervisor(() => agent({ runTurn: async () => { throw new Error("boom"); } }) as any, noAsk, undefined, "call");
  const { events, emit } = collect();
  await sup.runTurn({ text: "hi", frames: [] }, emit, new AbortController().signal);
  assert.deepEqual(events.filter((e) => e.type === "error").map((e) => e.code), ["agent_crashed"]);
  assert.deepEqual(brainErrors(sent), [{ surface: "call", brain_kind: "acp", brain_id: "claude-code", class: "agent_crashed", http_class: "none", recovered: true }]);
  assert.equal(restarts(sent), 1);
  assert.deepEqual(sent.filter((m) => m.scope === "call" && m.props.errors).length, 1);
}));

test("a restart that fails is reported as not recovered, and counts no restart", () => reporting(async (sent) => {
  let built = 0;
  const sup = new AgentSupervisor(() => { built++; return agent({ start: async () => { if (built > 1) throw new Error("gone"); }, runTurn: async () => { throw new Error("boom"); } }) as any; }, noAsk, undefined, "flow");
  await sup.runTurn({ text: "hi", frames: [] }, collect().emit, new AbortController().signal);
  assert.deepEqual(brainErrors(sent).map((p) => [p.surface, p.recovered]), [["flow", false]]);
  assert.equal(restarts(sent), 0);
}));

test("a silent agent and a stalled one are told apart", () => reporting(async (sent) => {
  const quiet = new AgentSupervisor(() => agent({ runTurn: (_i: unknown, _e: unknown, signal: AbortSignal) => new Promise<void>((res) => signal.addEventListener("abort", () => res())) }) as any, noAsk, { firstOutputMs: 30 }, "flow");
  const a = collect();
  await quiet.runTurn({ text: "hi", frames: [] }, a.emit, new AbortController().signal);
  const stalls = new AgentSupervisor(() => agent({ runTurn: (_i: unknown, emit: (e: unknown) => void, signal: AbortSignal) => new Promise<void>((res) => { emit({ type: "text_delta", text: "One" }); signal.addEventListener("abort", () => res()); }) }) as any, noAsk, { stallMs: 30 }, "call");
  const b = collect();
  await stalls.runTurn({ text: "hi", frames: [] }, b.emit, new AbortController().signal);
  assert.deepEqual([a.events.at(-1).code, b.events.at(-1).code], ["agent_no_output", "agent_stalled"]);
  assert.deepEqual(brainErrors(sent).map((p) => [p.surface, p.class]), [["flow", "agent_no_output"], ["call", "agent_stalled"]]);
}));

test("a supervisor made for no session reports nothing, and a barge-in is never an incident", () => reporting(async (sent) => {
  const sup = new AgentSupervisor(() => agent({ runTurn: async () => { throw new Error("boom"); } }) as any, noAsk);
  await sup.runTurn({ text: "hi", frames: [] }, collect().emit, new AbortController().signal);
  const parent = new AbortController();
  const barged = new AgentSupervisor(() => agent({ runTurn: (_i: unknown, _e: unknown, signal: AbortSignal) => new Promise<void>((res) => signal.addEventListener("abort", () => res())) }) as any, noAsk, undefined, "call");
  const turn = barged.runTurn({ text: "hi", frames: [] }, collect().emit, parent.signal);
  setTimeout(() => parent.abort(), 10);
  await turn;
  assert.deepEqual(sent, []);
}));

test("a start that runs out of time carries its own class", async () => {
  const sup = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}) }) as any, noAsk, { startMs: 20 });
  await assert.rejects(sup.start(new AbortController().signal), (e: any) => e.errorClass === "agent_start_timeout");
});
