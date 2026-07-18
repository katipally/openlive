// The supervisor makes external agents safe to ship: a hung or crashed agent
// process must end as a SPOKEN error, never a session stuck listening.
import assert from "node:assert";
import { test } from "vitest";
import { AgentSupervisor } from "./supervisor.ts";

const agent = (over: object) => ({ id: "claude-code" as const, start: async () => {}, seed: () => {}, runTurn: async () => {}, dispose: async () => {}, ...over });
const collect = () => { const events: any[] = []; return { events, emit: (e: any) => { events.push(e); } }; };
const noAsk = async () => "deny"; // the supervisor's askPermission arg — unused in these turns

test("a start that never resolves rejects on the deadline instead of hanging forever", async () => {
  const sup = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}) }) as any, noAsk, { startMs: 50 });
  await assert.rejects(sup.start(new AbortController().signal), /didn't become ready/);
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
