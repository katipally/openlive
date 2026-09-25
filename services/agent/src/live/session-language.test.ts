// The session language rides on each turn: the built-in model is told once, in
// its system prompt, to answer in it, and an English turn sends exactly the
// prompt it always did.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { liveClientMsgSchema, withReplyLanguage } from "@openlive/shared";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-lang-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession, stripInjectedContext } = await import("./session.ts");
const { setSetting } = await import("@openlive/db");
const { buildLivePrompt } = await import("../prompt.ts");

// A local OpenAI Responses stub, reached as the keyless Ollama provider; it keeps each request's system prompt.
const instructions: string[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const b = JSON.parse(body);
    instructions.push(b.instructions ?? JSON.stringify(b.input?.filter((m: { role?: string }) => m.role === "system")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hola." })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`);
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

test("each turn's language reaches the system prompt; English leaves it untouched", async () => {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
  (ws as any).send = (raw: string) => ws.sent.push(JSON.parse(raw));
  const say = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  const done = async (n: number) => { while (ws.sent.filter((m) => m.event?.type === "done").length < n) await new Promise((r) => setTimeout(r, 10)); };
  const started = new LiveSession(ws as never, "lang-chat").start();
  say({ t: "bind", agentId: null, cwd: "" });
  await started;
  say({ t: "user_text", text: "Hello." });
  await done(1);
  say({ t: "user_text", text: "Hola.", lang: "es" });
  await done(2);
  say({ t: "user_text", text: "Back to English." });
  await done(3);
  // The connect-time warm-up may send one more request first, with the English prompt.
  const [en, es, back] = instructions.slice(-3);
  expect(en!.startsWith(buildLivePrompt().slice(0, 200))).toBe(true);
  expect(en).not.toContain("Always reply in");
  expect(es).toBe(`${en}\n\n---\nAlways reply in Spanish.`);
  expect(back).toBe(en); // a language change applies from the next turn, both ways
  ws.emit("close");
});

test("the connect-time warm-up primes the prompt in the language the call opened in", async () => {
  const warmed = async (lang?: "es") => {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
    (ws as any).send = (raw: string) => ws.sent.push(JSON.parse(raw));
    const before = instructions.length;
    await new LiveSession(ws as never, `warm-${lang ?? "en"}`, lang).start();
    while (!ws.sent.some((m) => m.event?.type === "status" && m.event.text === "ready")) await new Promise((r) => setTimeout(r, 10));
    ws.emit("close");
    return instructions.slice(before);
  };
  const [en] = await warmed();
  const [es] = await warmed("es");
  expect(en!.startsWith(buildLivePrompt().slice(0, 200))).toBe(true);
  expect(en).not.toContain("Always reply in");
  expect(es).toBe(`${en}\n\n---\nAlways reply in Spanish.`);
});

test("the turn schema takes a curated language and refuses any other", () => {
  expect(liveClientMsgSchema.safeParse({ t: "user_text", text: "x", lang: "ja" }).success).toBe(true);
  expect(liveClientMsgSchema.safeParse({ t: "flow_text", text: "x", lang: "zh" }).success).toBe(true);
  expect(liveClientMsgSchema.safeParse({ t: "user_text", text: "x", lang: "tlh" }).success).toBe(false);
  expect(liveClientMsgSchema.safeParse({ t: "user_text", text: "x" }).success).toBe(true);
});

test("a coding agent gets the language at the head of the turn, and a replay drops it again", () => {
  expect(withReplyLanguage("fix the build", "en")).toBe("fix the build");
  expect(withReplyLanguage("fix the build")).toBe("fix the build");
  expect(withReplyLanguage("arregla el build", "es")).toBe("[Always reply in Spanish.]\n\narregla el build");
  expect(withReplyLanguage("直して", "zh")).toBe("[Always reply in Mandarin Chinese, in simplified characters.]\n\n直して");
  expect(stripInjectedContext([{ type: "text", text: withReplyLanguage("arregla el build", "es") }])).toEqual([{ type: "text", text: "arregla el build" }]);
});
