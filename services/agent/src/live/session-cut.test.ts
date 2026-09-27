// A model streams a reply far faster than the voice speaks it, so the user
// usually cuts in after the turn is over and saved. The cut must still reach the
// transcript and the model's memory, or both claim words the user never heard.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-cut-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession } = await import("./session.ts");
const { getSetting, listMessages, setSetting } = await import("@openlive/db");

// A local OpenAI Responses stub, reached as the keyless Ollama provider.
const inputs: { role?: string; content?: unknown }[][] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const input = JSON.parse(body).input ?? [];
    inputs.push(input);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const deltas = ["One. ", "Two. ", "Three."].map((delta) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
    const end = `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`;
    // "Slowly" holds the reply open after its first word, so a cut lands mid-turn.
    if (JSON.stringify(input.at(-1)).includes("slowly")) { res.write(deltas[0]); setTimeout(() => res.end(deltas.slice(1).join("") + end), 500); return; }
    res.end(deltas.join("") + end);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
await setSetting("liveProviderId", "ollama");
await setSetting("liveModel", "stub");
await setSetting("ollamaBaseUrl", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);

afterAll(() => {
  server.close();
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function connect(chatId: string) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
  (ws as any).send = (raw: string) => ws.sent.push(JSON.parse(raw));
  const say = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 10)); };
  const done = (n: number) => until(() => ws.sent.filter((m) => m.event?.type === "done").length >= n);
  const session = new LiveSession(ws as never, chatId);
  const started = session.start();
  say({ t: "bind", agentId: null, cwd: "" });
  return { ws, say, until, done, started, session };
}
const lastReply = (chatId: string) => listMessages(chatId).filter((m) => m.role === "assistant").at(-1)?.content;

test("a barge-in after the reply was saved cuts it back to what was voiced, and a turn sent on connect runs once", async () => {
  const { ws, say, done, started } = connect("cut-chat");
  // A reconnect flushes a queued utterance right behind the bind.
  say({ t: "user_text", text: "Count to three." });
  await started;
  await done(1);
  say({ t: "cancel", spoken: "One." });
  expect(lastReply("cut-chat")).toEqual([{ type: "text", text: "One." }]);

  say({ t: "user_text", text: "Go on." });
  await done(2);
  // One request per turn, each with the history once: the turn sent on connect
  // was neither loaded twice nor sent again by the connect-time warm-up.
  expect(inputs.map((i) => i.map((m) => `${m.role}:${JSON.stringify(m.content)}`))).toEqual([
    ['user:"Count to three."'],
    ['user:"Count to three."', 'assistant:"One."', 'user:"Go on."'],
  ]);
  ws.emit("close");
});

test("a barge-in before any of the reply was voiced keeps none of it", async () => {
  const { ws, say, done, started } = connect("cut-empty");
  say({ t: "user_text", text: "Count to three." });
  await started;
  await done(1);
  say({ t: "cancel", spoken: "" });
  expect(lastReply("cut-empty")).toEqual([{ type: "text", text: "" }]);
  say({ t: "user_text", text: "Go on." });
  await done(2);
  expect(inputs.at(-1)!.map((m) => `${m.role}:${JSON.stringify(m.content)}`)).toEqual(['user:"Count to three."', 'user:"Go on."']);
  ws.emit("close");
});

test("a spoken turn is saved with its word onsets, two joined behind a turn keep none, and the model sees only words", async () => {
  const { ws, say, until, done, started } = connect("words-at");
  say({ t: "user_text", text: "Count slowly.", wordsAt: [800, 1100] });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  say({ t: "user_text", text: "Also this.", wordsAt: [900, 1200] });
  say({ t: "user_text", text: "And that.", wordsAt: [700, 1000] });
  await done(2);
  expect(listMessages("words-at").filter((m) => m.role === "user").map((m) => m.content)).toEqual([
    [{ type: "text", text: "Count slowly.", wordsAt: [800, 1100] }],
    [{ type: "text", text: "Also this. And that." }],
  ]);
  expect(JSON.stringify(inputs.at(-1))).not.toContain("wordsAt");
  ws.emit("close");
});

test("a cut mid-turn with nothing voiced yet saves none of the reply", async () => {
  const { ws, say, until, done, started } = connect("cut-mid");
  say({ t: "user_text", text: "Count slowly." });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  say({ t: "cancel" });
  await done(1);
  expect(lastReply("cut-mid")).toEqual([{ type: "text", text: "" }]);
  ws.emit("close");
});

test("a cut turn's closing done carries its own number, and the next turn's reply carries the next", async () => {
  const { ws, say, until, done, started } = connect("cut-turns");
  say({ t: "user_text", text: "Count slowly.", turn: 1 });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  say({ t: "cancel" });
  say({ t: "user_text", text: "Go on.", turn: 2 });
  await done(2);
  const turns = ws.sent.filter((m) => m.t === "sse" && m.turn !== undefined).map((m) => `${m.event.type}:${m.turn}`);
  expect(turns.filter((t) => t.startsWith("done"))).toEqual(["done:1", "done:2"]);
  expect(turns.slice(turns.indexOf("done:1") + 1).every((t) => t.endsWith(":2"))).toBe(true);
  ws.emit("close");
});

test("an agent's ask carries its turn's number, and one arriving after the turn is refused", async () => {
  const { ws, say, until, done, started, session } = connect("cut-asks");
  const ask = () => (session as any).askPermission("Run it?", [{ id: "ok", label: "Allow", kind: "allow_once" }]) as Promise<string>;
  say({ t: "user_text", text: "Count slowly.", turn: 4 });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  const answered = ask();
  await until(() => ws.sent.some((m) => m.t === "permission"));
  const asked = ws.sent.find((m) => m.t === "permission")!;
  expect(asked.turn).toBe(4);
  say({ t: "permission_response", reqId: asked.reqId, optionId: "ok" });
  expect(await answered).toBe("ok");
  say({ t: "cancel" });
  await done(1);
  // Left pending, it would take the next utterance as its answer.
  expect(await ask()).toBe("__acp_cancelled__");
  expect(ws.sent.filter((m) => m.t === "permission")).toHaveLength(1);
  ws.emit("close");
});

test("a sentence refuses an ask the client never showed and runs as a turn, numbered or not", async () => {
  const { ws, say, until, done, started, session } = connect("cut-unseen");
  const ask = () => (session as any).askPermission("Run it?", [{ id: "ok", label: "Allow", kind: "allow_once" }]) as Promise<string>;
  say({ t: "user_text", text: "Count slowly.", turn: 1 });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  const unnumbered = ask();
  await until(() => ws.sent.some((m) => m.t === "permission"));
  say({ t: "user_text", text: "Is it done?" });
  expect(await unnumbered).toBe("__acp_cancelled__");
  const numbered = ask();
  await until(() => ws.sent.filter((m) => m.t === "permission").length === 2);
  // Said before the ask reached the client, which drops an older turn's ask.
  say({ t: "user_text", text: "Also count to five.", turn: 2 });
  expect(await numbered).toBe("__acp_cancelled__");
  await done(2);
  expect(JSON.stringify(inputs.at(-1))).toContain("Is it done? Also count to five.");
  ws.emit("close");
});

test("a barge-in over an ask the client never showed refuses it and ends the turn, so the next sentence runs", async () => {
  const { ws, say, until, done, started, session } = connect("cut-barge-ask");
  say({ t: "user_text", text: "Count slowly.", turn: 1 });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  const asked = (session as any).askPermission("Run it?", [{ id: "ok", label: "Allow", kind: "allow_once" }]) as Promise<string>;
  await until(() => ws.sent.some((m) => m.t === "permission"));
  say({ t: "cancel" });
  expect(await asked).toBe("__acp_cancelled__");
  await done(1);
  // Aborted, not run to its end behind the refused ask.
  expect(ws.sent.some((m) => m.turn === 1 && m.event?.type === "text_delta" && JSON.stringify(m.event).includes("Two"))).toBe(false);
  say({ t: "user_text", text: "Count to three.", turn: 2 });
  await done(2);
  expect(ws.sent.filter((m) => m.event?.type === "done").map((m) => m.turn)).toEqual([1, 2]);
  ws.emit("close");
});

test("outside a turn only a request-scoped elicitation is shown, unnumbered, and a session-scoped one is refused", async () => {
  const { ws, say, until, done, started, session } = connect("cut-elicit");
  const elicit = (requestScoped?: boolean) => (session as any).askElicitation({ mode: "form", message: "Name?", schema: {}, requestScoped }) as Promise<{ action: string }>;
  say({ t: "user_text", text: "Count to three.", turn: 3 });
  await started;
  await done(1);
  expect(await elicit()).toEqual({ action: "cancel" });
  expect(ws.sent.some((m) => m.t === "elicitation")).toBe(false);

  const login = elicit(true);
  await until(() => ws.sent.some((m) => m.t === "elicitation"));
  const asked = ws.sent.find((m) => m.t === "elicitation")!;
  expect(asked.turn).toBeUndefined();
  say({ t: "elicitation_response", reqId: asked.reqId, action: "accept" });
  expect(await login).toEqual({ action: "accept" });
  ws.emit("close");
});

/** A stub ACP agent that takes no images: it logs each prompt and answers "One. Two. Three." */
async function stubAgent() {
  const sdk = pathToFileURL(createRequire(import.meta.url).resolve("@agentclientprotocol/sdk")).href;
  const log = join(dir, "prompts.jsonl");
  const stub = join(dir, "stub-agent.mjs");
  writeFileSync(stub, `
    import { appendFileSync } from "node:fs";
    import { Readable, Writable } from "node:stream";
    import { AgentSideConnection, ndJsonStream } from ${JSON.stringify(sdk)};
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
    new AgentSideConnection((conn) => ({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      newSession: async () => ({ sessionId: "s1" }),
      loadSession: async () => ({}),
      authenticate: async () => ({}),
      cancel: async () => {},
      prompt: async (p) => {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify(p.prompt[0].text) + "\\n");
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "One. Two. Three." } } });
        return { stopReason: "end_turn" };
      },
    }), stream);
  `);
  await setSetting("acpCommand:codex", `${process.execPath} ${stub}`);
  const prompts = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
  return { prompts, bindAgent: (say: (m: unknown) => void) => say({ t: "bind", agentId: "codex", cwd: dir }) };
}

test("a coding agent keeps its own memory of a reply, so its next turn says what was heard, even after a reconnect", async () => {
  const { prompts, bindAgent } = await stubAgent();

  const a = connect("cut-agent");
  bindAgent(a.say);
  await a.started;
  a.say({ t: "user_text", text: "Count to three." });
  await a.done(1);
  a.say({ t: "cancel", spoken: "One." });
  expect(lastReply("cut-agent")).toEqual([{ type: "text", text: "One." }]);
  a.say({ t: "user_text", text: "Go on." });
  await a.done(2);
  expect(prompts()[0]).not.toContain("cut you off");
  expect(prompts()[1]).toContain('[The user cut you off. Of your last reply they heard only: "One."]\n\nGo on.');
  expect(getSetting("agentCut:cut-agent")).toBe("");

  // Hung up before a word of the next reply: the resumed session is told on its first turn.
  a.say({ t: "cancel", spoken: "" });
  a.ws.emit("close");
  const b = connect("cut-agent");
  bindAgent(b.say);
  await b.started;
  b.say({ t: "user_text", text: "Where were we?" });
  await b.done(1);
  expect(prompts()[2]).toContain("[The user cut you off before hearing any of your last reply.]");
  b.ws.emit("close");
}, 20_000);

test("a coding agent that takes no images sees the camera through the vision model, as the built-in brain does", async () => {
  const { prompts, bindAgent } = await stubAgent();
  await setSetting("visionProviderId", "ollama");
  await setSetting("visionModel", "eyes");
  const c = connect("agent-vision");
  bindAgent(c.say);
  await c.started;
  c.say({ t: "user_text", text: "What do you see?", frames: [{ data: "AAAA", mime: "image/jpeg", source: "camera" }] });
  await c.done(1);
  expect(prompts().at(-1)).toContain("[A vision model is looking at the user's camera live right now and reports: One. Two. Three.");
  await setSetting("visionProviderId", "");
  c.ws.emit("close");
}, 20_000);

test("a spoken turn's speaker is saved, and neither the built-in brain nor a coding agent is told it", async () => {
  const api = connect("speaker-api");
  api.say({ t: "user_text", text: "Count to three.", speaker: "other 1" });
  await api.started;
  await api.done(1);
  api.ws.emit("close");

  const { prompts, bindAgent } = await stubAgent();
  const acp = connect("speaker-acp");
  bindAgent(acp.say);
  await acp.started;
  acp.say({ t: "user_text", text: "Count to three.", speaker: "other 1" });
  await acp.done(1);
  acp.ws.emit("close");

  for (const chat of ["speaker-api", "speaker-acp"]) {
    expect(listMessages(chat).find((m) => m.role === "user")!.content).toEqual([{ type: "text", text: "Count to three.", speaker: "other 1" }]);
  }
  expect(JSON.stringify(inputs.at(-1))).not.toContain("other 1");
  expect(prompts().at(-1)).not.toContain("other 1");
}, 20_000);
