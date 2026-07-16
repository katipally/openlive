// The supervisor makes external agents safe to ship: a hung or crashed agent
// process must end as a SPOKEN error, never a session stuck listening.
import assert from "node:assert";
import { test } from "vitest";
import { AgentSupervisor } from "./supervisor.ts";

const agent = (over: object) => ({ id: "claude-code" as const, start: async () => {}, seed: () => {}, runTurn: async () => {}, dispose: async () => {}, ...over });
const collect = () => { const events: any[] = []; return { events, emit: (e: any) => { events.push(e); } }; };

test("a start that never resolves rejects on the deadline instead of hanging forever", async () => {
  const sup = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}) }) as any, { startMs: 50 });
  await assert.rejects(sup.start(new AbortController().signal), /didn't become ready/);
});

test("a crashed turn emits a spoken line + structured error and recycles ONCE", async () => {
  let built = 0;
  const sup = new AgentSupervisor(() => { built++; return agent({ runTurn: async () => { throw new Error("boom"); } }) as any; });
  const { events, emit } = collect();
  await sup.runTurn({ text: "hi", frames: [] }, emit, new AbortController().signal);
  assert.ok(events.some((e) => e.type === "text_delta"), "spoke, not dead air");
  assert.ok(events.some((e) => e.type === "error" && /boom/.test(e.message)), "structured error");
  assert.equal(built, 2, "restart-once fired");
  await sup.runTurn({ text: "again", frames: [] }, emit, new AbortController().signal);
  assert.equal(built, 2, "restart budget already spent");
});

test("barge-in (parent signal abort) is NOT a failure — no error events", async () => {
  const parent = new AbortController();
  const sup = new AgentSupervisor(() => agent({ runTurn: (_i: unknown, _e: unknown, signal: AbortSignal) => new Promise<void>((res) => signal.addEventListener("abort", () => res())) }) as any);
  const { events, emit } = collect();
  const turn = sup.runTurn({ text: "hi", frames: [] }, emit, parent.signal);
  setTimeout(() => parent.abort(), 20);
  await turn;
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});
