// A coding agent in a call gets the call's own tools over MCP: the same objects
// the built-in brain runs, answered through the same client bridge, numbered by
// the same turn, and shown the way the built-in brain's are.
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
const dir = mkdtempSync(join(tmpdir(), "ol-call-mcp-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession } = await import("./session.ts");
const { getSetting, listMessages, setSetting } = await import("@openlive/db");

afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A stub ACP agent that, on each prompt, calls OpenLive's tools over the MCP
 *  server it was handed, reports those calls and one of its own as tool calls,
 *  and says what came back. Asked to open something, it asks permission for
 *  OpenLive's open_url as Codex does and says the answer. A loaded session
 *  replays a look of OpenLive's and a read of its own. */
async function stubAgent(id = "codex") {
  const req = createRequire(import.meta.url);
  const url = (m: string) => JSON.stringify(pathToFileURL(req.resolve(m)).href);
  const log = join(dir, "prompts.jsonl");
  const stub = join(dir, "stub-agent.mjs");
  writeFileSync(stub, `
    import { appendFileSync } from "node:fs";
    import { Readable, Writable } from "node:stream";
    import { AgentSideConnection, ndJsonStream } from ${url("@agentclientprotocol/sdk")};
    import { Client } from ${url("@modelcontextprotocol/sdk/client/index.js")};
    import { StreamableHTTPClientTransport } from ${url("@modelcontextprotocol/sdk/client/streamableHttp.js")};
    let server, meta;
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
    new AgentSideConnection((conn) => {
      const update = (sessionId, u) => conn.sessionUpdate({ sessionId, update: u });
      return {
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        newSession: async (p) => { server = p.mcpServers[0]; meta = p._meta; return { sessionId: "s1" }; },
        loadSession: async (p) => {
          server = p.mcpServers[0];
          await update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look at this." } });
          await update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "l", title: "mcp__openlive__look", kind: "other", status: "pending" });
          await update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "l", status: "completed" });
          await update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "own", title: "Read notes.md", kind: "read", status: "completed" });
          await update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A cup." } });
          return {};
        },
        authenticate: async () => ({}),
        cancel: async () => {},
        prompt: async (p) => {
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text: p.prompt[0].text, server: server?.name, meta }) + "\\n");
          if (p.prompt[0].text.includes("Open the docs")) {
            await update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "ask", title: "mcp.openlive.open_url", kind: "execute", status: "pending" });
            const r = await conn.requestPermission({ sessionId: p.sessionId, toolCall: { toolCallId: "ask" }, options: [
              { optionId: "approved", name: "Allow", kind: "allow_once" }, { optionId: "declined", name: "Decline", kind: "reject_once" }] });
            await update(p.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: r.outcome.optionId ?? r.outcome.outcome } });
            return { stopReason: "end_turn" };
          }
          const mcp = new Client({ name: "stub", version: "1" });
          await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
          const reads = (await mcp.listTools()).tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ reads }) + "\\n");
          const said = [];
          for (const [name, args] of [["clipboard_write", { text: "copied" }], ["remember", { note: "Likes tea." }], ["look", {}]]) {
            await update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: name, title: "mcp__openlive__" + name, kind: "other", status: "pending" });
            const r = await mcp.callTool({ name, arguments: args });
            await update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: name, status: "completed" });
            said.push(r.content.map((c) => c.type === "text" ? c.text : c.type).join(" "));
          }
          await mcp.close();
          await update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "own", title: "Read notes.md", kind: "read", status: "completed" });
          await update(p.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: said.join(" | ") } });
          return { stopReason: "end_turn" };
        },
      };
    }, stream);
  `);
  await setSetting(`acpCommand:${id}`, `${process.execPath} ${stub}`);
  return () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; server: string; meta?: any }).filter((l) => l.text);
}

/** A call as the desktop client holds it: the bridge and the camera answered. */
function connect(chatId: string, agentId: string | null = "codex", resumeSessionId?: string) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
  const say = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  (ws as any).send = (raw: string) => {
    const m = JSON.parse(raw);
    ws.sent.push(m);
    if (m.t === "tool_bridge") queueMicrotask(() => say({ t: "tool_bridge_result", reqId: m.reqId, output: `${m.op} ok` }));
    if (m.t === "need_frame") queueMicrotask(() => {
      say({ t: "frame_response", reqId: m.reqId });
      ws.emit("message", Buffer.from([0x02, 0xff, 0xd8]), true);
    });
  };
  const done = async () => { while (!ws.sent.some((m) => m.event?.type === "done")) await new Promise((r) => setTimeout(r, 10)); };
  const started = new LiveSession(ws as never, chatId).start();
  say({ t: "bind", agentId, cwd: dir, resumeSessionId });
  return { ws, say, done, started };
}

test("a coding agent in a call uses look, the clipboard and remember as the built-in brain does", async () => {
  const prompts = await stubAgent();
  const { ws, say, done, started } = connect("call-mcp");
  await started;
  say({ t: "control", action: "camera_on" });
  say({ t: "user_text", text: "Copy that, remember I like tea, and look at this.", turn: 7 });
  await done();

  expect(prompts()[0]!.server).toBe("openlive");
  expect(readFileSync(join(dir, "prompts.jsonl"), "utf8")).toContain('{"reads":["look","clipboard_read"]}');
  expect(prompts()[0]!.text).toContain('a server called "openlive": look, clipboard_read, clipboard_write, open_url, remember');
  expect(ws.sent.find((m) => m.t === "tool_bridge")).toMatchObject({ op: "clipboard_write", arg: "copied", turn: 7 });
  expect(ws.sent.some((m) => m.t === "need_frame")).toBe(true);
  expect(JSON.parse(getSetting("agent_notes") ?? "[]")).toEqual(["Likes tea."]);
  // The built-in brain's chips, and the agent's own tool as a card; the agent's
  // report of OpenLive's tools is not a second copy of them.
  const chips = ws.sent.filter((m) => m.event?.type === "tool_start");
  expect(chips.map((m) => m.event.tool)).toEqual(["clipboard_write", "remember", "look"]);
  expect(chips[1]).toMatchObject({ event: { summary: "Likes tea." }, turn: 7 });
  expect(ws.sent.filter((m) => m.event?.type === "tool_done")).toHaveLength(3);
  const cards = ws.sent.filter((m) => m.event?.type === "acp_tool_call" || m.event?.type === "acp_tool_update");
  expect(cards.map((m) => m.event.call?.id ?? m.event.delta.id)).toEqual(["own"]);
  const reply = ws.sent.filter((m) => m.event?.type === "text_delta").map((m) => m.event.text).join("");
  const [copied, remembered, looked] = reply.split(" | ");
  expect(copied).toBe("clipboard_write ok");
  expect(remembered).toMatch(/^Got it/);
  expect(looked).toMatch(/^This is what the user's camera is showing right now.* image$/);
  ws.emit("close");
}, 20_000);

test("a coding agent is told what the built-in brain remembered", async () => {
  const prompts = await stubAgent();
  await setSetting("agent_notes", JSON.stringify(["Their name is Sam."]));
  const { ws, say, done, started } = connect("call-notes");
  await started;
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(prompts().at(-1)!.text).toContain("- Their name is Sam.");
  ws.emit("close");
}, 20_000);

test("a coding agent keeps what it learns about the user in OpenLive's memory, which every brain reads", async () => {
  const { callPreamble } = await import("../agents/acp-agent.ts");
  expect(callPreamble(["look", "remember"])).toContain("save it with OpenLive's remember tool, never your own memory");
  expect(callPreamble(["look"])).not.toContain("remember tool");
});

test("an agent that asks before one of OpenLive's tools gets a proper ask, and the answer", async () => {
  await stubAgent();
  const { ws, say, done, started } = connect("call-ask");
  await started;
  say({ t: "user_text", text: "Open the docs.", turn: 3 });
  while (!ws.sent.some((m) => m.t === "permission")) await new Promise((r) => setTimeout(r, 10));
  const ask = ws.sent.find((m) => m.t === "permission")!;
  expect(ask).toMatchObject({ question: "Codex wants permission: OpenLive's open url. Allow it?", toolCallId: "ask", turn: 3 });
  expect(ask.options.map((o: { kind: string }) => o.kind)).toEqual(["allow_once", "reject_once"]);
  say({ t: "permission_response", reqId: ask.reqId, optionId: "declined" });
  await done();
  expect(ws.sent.filter((m) => m.event?.type === "text_delta").map((m) => m.event.text).join("")).toBe("declined");
  // The rejection settles a card nobody sees, so it stays unseen.
  expect(ws.sent.some((m) => m.event?.type === "acp_tool_call" || m.event?.type === "acp_tool_update")).toBe(false);
  ws.emit("close");
}, 20_000);

test("a resumed session replays OpenLive's tools as it showed them live", async () => {
  await stubAgent();
  const { ws, started } = connect("call-replay", "codex", "old");
  await started;
  while (!ws.sent.some((m) => m.t === "reload_history")) await new Promise((r) => setTimeout(r, 10));
  const blocks = listMessages("call-replay").flatMap((m) => m.content);
  expect(blocks.filter((b) => b.type === "acp_tool").map((b) => b.type === "acp_tool" && b.call.id)).toEqual(["own"]);
  expect(blocks.some((b) => b.type === "text" && b.text === "A cup.")).toBe(true);
  ws.emit("close");
}, 20_000);

test("Claude Code calls OpenLive's tools without asking first", async () => {
  const prompts = await stubAgent("claude-code");
  const { ws, say, done, started } = connect("call-claude", "claude-code");
  await started;
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(prompts().at(-1)!.meta.claudeCode.options.allowedTools).toEqual(["mcp__openlive"]);
  ws.emit("close");
}, 20_000);

test("the built-in brain shows the same chip for a bridge tool", async () => {
  // A local OpenAI Responses stub, reached as the keyless Ollama provider: it
  // opens a link, then says it did.
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const answered = body.includes("function_call_output");
      const events = answered
        ? [{ type: "response.output_text.delta", delta: "Opened." }]
        : [{ type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "c1", name: "open_url" } },
          { type: "response.function_call_arguments.delta", item_id: "fc", delta: JSON.stringify({ url: "https://example.com" }) },
          { type: "response.function_call_arguments.done", item_id: "fc" }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([...events, { type: "response.completed", response: {} }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  await setSetting("liveProviderId", "ollama");
  await setSetting("liveModel", "stub");
  await setSetting("ollamaBaseUrl", `http://127.0.0.1:${(model.address() as AddressInfo).port}`);
  const { ws, say, done, started } = connect("call-builtin", null);
  await started;
  say({ t: "user_text", text: "Open example.com.", turn: 2 });
  await done();
  model.close();
  expect(ws.sent.find((m) => m.t === "tool_bridge")).toMatchObject({ op: "open_url", arg: "https://example.com" });
  expect(ws.sent.find((m) => m.event?.type === "tool_start")).toMatchObject({ event: { tool: "open_url", summary: "https://example.com" }, turn: 2 });
  expect(ws.sent.some((m) => m.event?.type === "tool_done")).toBe(true);
  ws.emit("close");
}, 20_000);
