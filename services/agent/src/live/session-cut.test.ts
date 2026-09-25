// A model streams a reply far faster than the voice speaks it, so the user
// usually cuts in after the turn is over and saved. The cut must still reach the
// transcript and the model's memory, or both claim words the user never heard.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-cut-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession } = await import("./session.ts");
const { listMessages, setSetting } = await import("@openlive/db");

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

test("a numbered sentence refuses an ask the client never showed and runs as a turn; an unnumbered one is bounced to it", async () => {
  const { ws, say, until, done, started, session } = connect("cut-unseen");
  const ask = () => (session as any).askPermission("Run it?", [{ id: "ok", label: "Allow", kind: "allow_once" }]) as Promise<string>;
  say({ t: "user_text", text: "Count slowly.", turn: 1 });
  await started;
  await until(() => ws.sent.some((m) => m.event?.type === "text_delta"));
  const bounced = ask();
  await until(() => ws.sent.some((m) => m.t === "permission"));
  say({ t: "user_text", text: "Is it done?" });
  await until(() => ws.sent.some((m) => m.t === "modal_voice_answer"));
  const refused = ask();
  await until(() => ws.sent.filter((m) => m.t === "permission").length === 2);
  // Said before the ask reached the client, which drops an older turn's ask.
  say({ t: "user_text", text: "Also count to five.", turn: 2 });
  expect(await bounced).toBe("__acp_cancelled__");
  expect(await refused).toBe("__acp_cancelled__");
  await done(2);
  expect(ws.sent.filter((m) => m.t === "modal_voice_answer")).toHaveLength(1);
  expect(JSON.stringify(inputs.at(-1))).toContain("Also count to five.");
  ws.emit("close");
});
