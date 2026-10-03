// What a call reports when the turn fails, whichever way it fails: the wire
// error carries a closed code, and main hears the class once per five minutes
// and every failure as a count.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-call-telemetry-"));
process.env.OPENLIVE_HOME = dir;
const { LiveSession } = await import("./session.ts");
const { closeDbForTests, setSetting } = await import("@openlive/db");
const { limits } = await import("../telemetry/limits.ts");
const { validateEvent, validateFact } = createRequire(import.meta.url)("../../../../apps/desktop/telemetry/validate.cjs");

// A local OpenAI Responses stub, reached as the keyless Ollama provider.
let reply: { status: number; body: string } = { status: 200, body: "" };
const model = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (reply.status !== 200) { res.writeHead(reply.status, { "retry-after": "0" }).end(reply.body); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi." })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`);
  });
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const useStub = async () => {
  await setSetting("liveProviderId", "ollama");
  await setSetting("liveModel", "stub");
  await setSetting("ollamaBaseUrl", `http://127.0.0.1:${(model.address() as AddressInfo).port}`);
};

type Sent = { kind: "event" | "fact"; name?: string; scope?: "flow" | "call"; props: Record<string, unknown> };
let sent: Sent[] = [];
beforeEach(() => { sent = []; limits.clear(); (process as unknown as { parentPort?: unknown }).parentPort = { postMessage: (m: Sent) => sent.push(m) }; });
afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; });
afterAll(() => {
  model.close();
  delete process.env.OPENLIVE_HOME;
  closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

const brainErrors = () => sent.filter((m) => m.name === "brain_error").map((m) => m.props);
const errorCount = () => sent.filter((m) => m.kind === "fact" && m.scope === "call" && m.props.errors).length;
const allAccepted = () => sent.every((m) => {
  const clean = m.kind === "event" ? validateEvent(m.name, m.props) : validateFact(m.scope === "flow" ? "agent_flow" : "agent_call", m.props);
  return !!clean && Object.keys(clean).sort().join() === Object.keys(m.props).sort().join();
});

/** A call as the desktop client holds it; each `turn` resolves once the reply is done. */
function connect(chatId: string, bind: { agentId: string | null; cwd: string } = { agentId: null, cwd: "" }) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
  const say = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  (ws as any).send = (raw: string) => ws.sent.push(JSON.parse(raw));
  const started = new LiveSession(ws as never, chatId).start();
  say({ t: "bind", ...bind });
  const turn = async (text: string) => {
    const before = ws.sent.filter((m) => m.event?.type === "done").length;
    say({ t: "user_text", text });
    while (ws.sent.filter((m) => m.event?.type === "done").length === before) await new Promise((r) => setTimeout(r, 10));
  };
  const errors = () => ws.sent.filter((m) => m.event?.type === "error").map((m) => m.event);
  return { ws, started, turn, errors };
}

test("a rejected key is coded as auth on the wire, reported once, and counted every time", async () => {
  await useStub();
  reply = { status: 401, body: '{"error":"bad key"}' };
  const { ws, started, turn, errors } = connect("fail-auth");
  await started;
  await turn("Hello.");
  await turn("Hello again.");
  expect(errors().map((e) => e.code)).toEqual(["auth", "auth"]);
  expect(errors()[0].message).toContain("rejected the API key");
  expect(brainErrors()).toEqual([{ surface: "call", brain_kind: "api", brain_id: "ollama", class: "auth", http_class: "4xx" }]);
  expect(errorCount()).toBe(2);
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);

test("a failed turn is not a timed turn or an answer, and a good one after it is both", async () => {
  await useStub();
  reply = { status: 500, body: "boom" };
  const { ws, started, turn, errors } = connect("fail-then-ok");
  await started;
  await turn("Hello.");
  expect(errors().map((e) => e.code)).toEqual(["server_error"]);
  expect(brainErrors()).toMatchObject([{ class: "server_error", http_class: "5xx" }]);
  const facts = () => sent.filter((m) => m.kind === "fact" && m.scope === "call").map((m) => m.props);
  expect(facts().find((f) => f.turns)).not.toHaveProperty("turn_ms");
  const steps = () => sent.filter((m) => m.name === "onboarding_step").map((m) => m.props.step);
  expect(steps()).toEqual([]);
  reply = { status: 200, body: "" };
  await turn("Try again.");
  expect(facts().filter((f) => f.turns).at(-1)).toMatchObject({ turns: 1, ttft_ms: expect.any(Number), turn_ms: expect.any(Number) });
  expect(steps()).toEqual(["first_call_reply", "activated"]);
  ws.emit("close");
}, 20_000);

test("an exhausted quota, a missing server and a missing key each carry their own code", async () => {
  await useStub();
  reply = { status: 429, body: '{"error":{"code":"insufficient_quota"}}' };
  const a = connect("fail-quota");
  await a.started;
  await a.turn("Hi.");
  expect(a.errors().map((e) => e.code)).toEqual(["quota"]);
  expect(a.errors()[0].message).toContain("quota exhausted");
  a.ws.emit("close");

  await setSetting("ollamaBaseUrl", "http://127.0.0.1:1");
  const b = connect("fail-down");
  await b.started;
  await b.turn("Hi.");
  expect(b.errors().map((e) => e.code)).toEqual(["unreachable"]);
  expect(b.errors()[0].message).toContain("Could not reach");
  b.ws.emit("close");

  await setSetting("liveProviderId", "anthropic");
  await setSetting("liveModel", "claude-x");
  const c = connect("fail-key");
  await c.started;
  await c.turn("Hi.");
  expect(c.errors().map((e) => e.code)).toEqual(["no_key"]);
  c.ws.emit("close");

  expect(brainErrors().map((p) => [p.class, p.brain_id])).toEqual([["quota", "ollama"], ["unreachable", "ollama"], ["no_key", "anthropic"]]);
  expect(allAccepted()).toBe(true);
}, 30_000);

test("a coding agent with no folder is told so, with the class main hears", async () => {
  const { ws, started, turn, errors } = connect("fail-folder", { agentId: "codex", cwd: "" });
  await started;
  await turn("Hello.");
  expect(errors().map((e) => e.code)).toEqual(["agent_no_folder"]);
  expect(brainErrors()).toEqual([{ surface: "call", brain_kind: "acp", brain_id: "codex", class: "agent_no_folder", http_class: "none" }]);
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);

test("Stop and camera and screen are told as they happen", async () => {
  await useStub();
  reply = { status: 200, body: "" };
  const { ws, started } = connect("controls");
  await started;
  const say = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  say({ t: "control", action: "camera_on" });
  say({ t: "control", action: "screen_on" });
  say({ t: "control", action: "camera_off" });
  say({ t: "cancel", spoken: "" });
  say({ t: "cancel" });
  expect(sent.filter((m) => m.kind === "fact").map((m) => m.props)).toEqual([{ camera_used: true }, { screen_used: true }, { interrupted: 1 }, { interrupted: 1 }]);
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);
