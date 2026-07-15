// Runnable self-check (no framework): `npx tsx src/agents/supervisor.test.ts`
// (tsx, not node --strip-types: supervisor.ts uses parameter properties.)
// The supervisor makes external agents safe to ship: a hung or crashed agent
// process must end as a SPOKEN error, never a session stuck listening.
import assert from "node:assert";
import { AgentSupervisor } from "./supervisor.ts";

const agent = (over) => ({ id: "claude-code", start: async () => {}, seed: () => {}, runTurn: async () => {}, dispose: async () => {}, ...over });
const collect = () => { const events = []; return { events, emit: (e) => { events.push(e); } }; };

// A start that never resolves rejects on the deadline instead of hanging forever.
await (async () => {
  const sup = new AgentSupervisor(() => agent({ start: () => new Promise(() => {}) }), { startMs: 50 });
  await assert.rejects(sup.start(new AbortController().signal), /didn't become ready/);
})();

// A crashed turn emits a spoken line + a structured error and recycles ONCE.
await (async () => {
  let built = 0;
  const sup = new AgentSupervisor(() => { built++; return agent({ runTurn: async () => { throw new Error("boom"); } }); });
  const { events, emit } = collect();
  await sup.runTurn({ text: "hi", frames: [] }, emit, new AbortController().signal);
  assert.ok(events.some((e) => e.type === "text_delta"), "spoke, not dead air");
  assert.ok(events.some((e) => e.type === "error" && /boom/.test(e.message)), "structured error");
  assert.equal(built, 2, "restart-once fired");
  await sup.runTurn({ text: "again", frames: [] }, emit, new AbortController().signal);
  assert.equal(built, 2, "restart budget already spent");
})();

// Barge-in (the parent signal aborting) is NOT a failure — no error events.
await (async () => {
  const parent = new AbortController();
  const sup = new AgentSupervisor(() => agent({ runTurn: (_i, _e, signal) => new Promise((res) => signal.addEventListener("abort", () => res())) }));
  const { events, emit } = collect();
  const turn = sup.runTurn({ text: "hi", frames: [] }, emit, parent.signal);
  setTimeout(() => parent.abort(), 20);
  await turn;
  assert.equal(events.filter((e) => e.type === "error").length, 0);
})();

console.log("supervisor.test.ts: all assertions passed");
