// The ACP driver against a scripted agent over real stdio (fake-acp-agent.fixture.mjs):
// slash commands, boolean config options, session/list paging and session/resume
// with its fallback. Plus the pure mappers they rest on.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import type { AgentMeta } from "./types.ts";

const FIXTURE = fileURLToPath(new URL("./fake-acp-agent.fixture.mjs", import.meta.url));
vi.mock("@openlive/db", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  // The driver's own override hook runs the fixture in place of the real adapter.
  getSetting: (k: string) => (k === "acpCommand:codex" ? adapter.command ?? `${process.execPath} ${FIXTURE}` : undefined),
}));
const adapter = vi.hoisted(() => ({ command: undefined as string | undefined }));

const { AcpAgent, commandsFromAcp, isAdvertised, optionFromAcp, sessionsFromAcp } = await import("./acp-agent.ts");

const cwd = mkdtempSync(join(tmpdir(), "acp-agent-test-"));
const live: { dispose(): Promise<void> }[] = [];
afterEach(async () => { adapter.command = undefined; delete (process as any).parentPort; await Promise.all(live.splice(0).map((a) => a.dispose())); });

function agent(opts: Record<string, unknown> = {}) {
  const metas: AgentMeta[] = [];
  const a = new AcpAgent("codex", async () => "deny", { cwd, onMeta: (m) => { metas.push(m); }, ...opts });
  live.push(a);
  return { a, metas, last: () => metas.at(-1)! };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok()); };
async function said(a: InstanceType<typeof AcpAgent>, input: { text: string; command?: string }): Promise<string[]> {
  let out = "";
  await a.runTurn({ frames: [], ...input }, (e) => { if (e.type === "text_delta") out += e.text; }, new AbortController().signal);
  return JSON.parse(out) as string[];
}

test("commands map to name, description and hint, without a leading slash", () => {
  assert.deepEqual(commandsFromAcp([
    { name: "/review", description: "Review", input: { hint: "what" } },
    { name: "compact", description: "Compact" },
    { name: "  ", description: "blank" },
  ]), [{ name: "review", description: "Review", hint: "what" }, { name: "compact", description: "Compact" }]);
  assert.deepEqual(commandsFromAcp(null), []);
  const cmds = [{ name: "review", description: "" }];
  assert.ok(isAdvertised("/review main", cmds));
  assert.ok(isAdvertised("  /review", cmds));
  assert.ok(!isAdvertised("/rev", cmds));
  assert.ok(!isAdvertised("review", cmds));
});

test("a boolean config option becomes an On/Off pair; a select keeps its values", () => {
  assert.deepEqual(optionFromAcp({ id: "fast", name: "Fast", type: "boolean", currentValue: true }),
    [{ id: "fast", label: "Fast", category: "", values: [{ id: "true", name: "On" }, { id: "false", name: "Off" }], currentId: "true" }]);
  assert.equal(optionFromAcp({ id: "fast", name: "Fast", type: "boolean", currentValue: false })[0]!.currentId, "false");
  assert.deepEqual(optionFromAcp({ id: "t", name: "Think", category: "thought_level", type: "select", currentValue: "lo", options: [{ value: "lo", name: "Low" }] }),
    [{ id: "t", label: "Think", category: "thought_level", values: [{ id: "lo", name: "Low" }], currentId: "lo" }]);
  assert.deepEqual(optionFromAcp({ id: "x", name: "X", type: "future" } as never), []);
});

test("session/list entries map to rows, dropping ones without an id or folder", () => {
  assert.deepEqual(sessionsFromAcp([
    { sessionId: "a", cwd: "/w", title: " Fix login ", updatedAt: "2026-09-01T10:00:00Z" },
    { sessionId: "b", cwd: "/w", title: null, updatedAt: "not a date" },
    { sessionId: "", cwd: "/w" },
    { sessionId: "c", cwd: "" },
  ]), [
    { id: "a", cwd: "/w", title: "Fix login", updatedAt: "2026-09-01T10:00:00.000Z" },
    { id: "b", cwd: "/w", title: "", updatedAt: "" },
  ]);
});

test("advertised commands reach meta, and one is sent alone as the first text block", async () => {
  const { a, last } = agent();
  await a.start(new AbortController().signal);
  await until(() => last().commands.length === 2);
  assert.deepEqual(last().commands, [{ name: "compact", description: "Compact the context" }, { name: "review", description: "Review changes", hint: "what to review" }]);
  // Advertised: the raw command alone, no preamble ahead of the slash.
  assert.deepEqual(await said(a, { text: "[reply in English]\n\n/review auth", command: "/review auth" }), ["/review auth"]);
  // The preamble was held for the next spoken turn, not spent on the command.
  const next = await said(a, { text: "hello" });
  assert.equal(next.length, 1);
  assert.match(next[0]!, /OpenLive[\s\S]*hello$/);
  // Not advertised: ordinary speech.
  assert.deepEqual(await said(a, { text: "/nope", command: "/nope" }), ["/nope"]);
}, 20_000);

test("a boolean option is set with a typed boolean and reads back as a switch", async () => {
  const { a, last } = agent();
  await a.start(new AbortController().signal);
  const fast = () => last().options.find((o) => o.id === "fast")!;
  assert.equal(fast().currentId, "false");
  assert.equal(last().models[0]!.id, "m1");
  await a.setOption("fast", "true");
  assert.equal(fast().currentId, "true");
}, 20_000);

test("session/list pages through the cursor, newest first, capped", async () => {
  const { a, metas } = agent({ connectOnly: true });
  await a.start(new AbortController().signal);
  assert.equal(metas.length, 0, "connect-only makes no session");
  const got = await a.listSessions(3);
  assert.deepEqual(got!.map((s) => [s.id, s.title]), [["s3", "Session 3"], ["s2", ""], ["s1", "Session 1"]]);
  assert.equal((await a.listSessions(60))!.length, 5);
}, 20_000);

test("resume uses session/resume without a replay, and falls back to load then new", async () => {
  const replays: unknown[] = [];
  const sessions: string[] = [];
  const onSession = (s: string) => { sessions.push(s); };
  const onReplay = (m: unknown) => { replays.push(m); };

  await agent({ resumeSessionId: "s1", onSession, onReplay }).a.start(new AbortController().signal);
  assert.deepEqual(sessions, ["s1"]);
  assert.equal(replays.length, 0, "resume replays nothing");

  // An empty chat wants its transcript back: session/load, which replays.
  await agent({ resumeSessionId: "s1", replay: true, onSession, onReplay }).a.start(new AbortController().signal);
  assert.equal(replays.length, 1);

  // Resume refused: load takes over (and replays, harmlessly into a full chat).
  await agent({ resumeSessionId: "gone", onSession, onReplay }).a.start(new AbortController().signal);
  assert.deepEqual(sessions, ["s1", "s1", "gone"]);
}, 20_000);

test("how a session came up is reported: none, resumed, loaded, or fell back to a fresh one", async () => {
  const hows: string[] = [];
  const onResumed = (how: string) => { hows.push(how); };
  await agent({ onResumed }).a.start(new AbortController().signal);
  await agent({ resumeSessionId: "s1", onResumed }).a.start(new AbortController().signal);
  await agent({ resumeSessionId: "gone", onResumed }).a.start(new AbortController().signal);
  await agent({ resumeSessionId: "lost", onResumed }).a.start(new AbortController().signal);
  assert.deepEqual(hows, ["none", "resumed", "loaded", "fell_back"]);
}, 20_000);

test("a start that fails carries its class, so nobody has to read its words, and reports nothing by itself", async () => {
  const sent: unknown[] = [];
  (process as any).parentPort = { postMessage: (m: unknown) => sent.push(m) };
  const classOf = async (opts: Record<string, unknown>) => {
    try { await agent(opts).a.start(new AbortController().signal); } catch (e) { return (e as { errorClass?: string }).errorClass; }
    return "started";
  };
  assert.equal(await classOf({ cwd: "" }), "agent_no_folder");
  assert.equal(await classOf({ cwd: join(cwd, "not-there") }), "agent_no_folder");
  adapter.command = "definitely-not-a-command-openlive";
  assert.equal(await classOf({}), "agent_start_failed");
  adapter.command = `${process.execPath} -e process.exit(3)`;
  assert.equal(await classOf({}), "agent_start_failed");
  // A probe (the model list, the session list) starts agents too: only a session reports its failures.
  assert.deepEqual(sent, []);
}, 20_000);

test("a refusal and a rejected turn end as errors with their own code", async () => {
  const { a } = agent();
  await a.start(new AbortController().signal);
  const errors: { message: string; code?: string }[] = [];
  const turn = (text: string) => a.runTurn({ text, frames: [] }, (e) => { if (e.type === "error") errors.push(e); }, new AbortController().signal);
  await turn("[refuse]");
  await turn("[reject]");
  assert.deepEqual(errors.map((e) => e.code), ["agent_refused", "agent_rejected"]);
}, 20_000);

test("the first successful start is announced once per start, and only with a stub port", async () => {
  const sent: any[] = [];
  await agent().a.start(new AbortController().signal);
  (process as any).parentPort = { postMessage: (m: unknown) => sent.push(m) };
  await agent().a.start(new AbortController().signal);
  assert.deepEqual(sent, [{ openlive: "telemetry", v: 1, kind: "event", name: "onboarding_step", props: { step: "first_agent_start_ok" } }]);
}, 20_000);

test("a probe (the model list, the session list) starting an agent is not a first start", async () => {
  const sent: unknown[] = [];
  (process as any).parentPort = { postMessage: (m: unknown) => sent.push(m) };
  await agent({ probe: true }).a.start(new AbortController().signal);
  await agent({ probe: true, connectOnly: true }).a.start(new AbortController().signal);
  assert.deepEqual(sent, []);
}, 20_000);
