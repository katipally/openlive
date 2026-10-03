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
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-call-mcp-"));
process.env.OPENLIVE_HOME = dir;
const { LiveSession } = await import("./session.ts");
const { closeDbForTests, listMessages, setSetting, updateMemory } = await import("@openlive/db");
const { readNotes } = await import("../memory/notes.ts");

afterAll(() => {
  delete process.env.OPENLIVE_HOME;
  closeDbForTests();
  // The stub agent's taskkill lands after close, and Windows will not remove a live process's working folder.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

// What the call reports to main, read the way main's validator would.
const { validateEvent, validateFact } = createRequire(import.meta.url)("../../../../apps/desktop/telemetry/validate.cjs");
type Sent = { kind: "event" | "fact"; name?: string; scope?: "flow" | "call"; props: Record<string, unknown> };
let sent: Sent[] = [];
beforeEach(() => { sent = []; (process as unknown as { parentPort?: unknown }).parentPort = { postMessage: (m: Sent) => sent.push(m) }; });
afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; });
const callFacts = () => sent.filter((m) => m.kind === "fact" && m.scope === "call").map((m) => m.props);
const total = (key: string) => callFacts().reduce((n, f) => n + (typeof f[key] === "number" ? (f[key] as number) : 0), 0);
/** Nothing dropped: the validator keeps every prop, though it rounds the numbers. */
const allAccepted = () => sent.every((m) => {
  const clean = m.kind === "event" ? validateEvent(m.name, m.props) : validateFact(m.scope === "flow" ? "agent_flow" : "agent_call", m.props);
  return !!clean && Object.keys(clean).sort().join() === Object.keys(m.props).sort().join();
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
function connect(chatId: string, agentId: string | null = "codex", resumeSessionId?: string, device = false) {
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
  const started = new LiveSession(ws as never, chatId, undefined, device).start();
  say({ t: "bind", agentId, cwd: dir, resumeSessionId });
  return { ws, say, done, started };
}

const CALL_TOOLS = "delegate, update_todos, remember, look, clipboard_read, clipboard_write, open_url, list_dir, read_file, write_file, edit_file, set_timer, remind, list_reminders, cancel_reminder, find_files, list_edits, undo_edit, save_skill, list_connectors, add_connector, connector_sign_in, reconnect_connector";

test("a coding agent in a call uses look, the clipboard and remember as the built-in brain does", async () => {
  const prompts = await stubAgent();
  const { ws, say, done, started } = connect("call-mcp");
  await started;
  say({ t: "control", action: "camera_on" });
  say({ t: "user_text", text: "Copy that, remember I like tea, and look at this.", turn: 7 });
  await done();

  expect(prompts()[0]!.server).toBe("openlive");
  expect(readFileSync(join(dir, "prompts.jsonl"), "utf8")).toContain('{"reads":["delegate","look","clipboard_read","list_dir","read_file","list_reminders","find_files","list_edits","list_connectors"]}');
  expect(prompts()[0]!.text).toContain(`a server called "openlive": ${CALL_TOOLS}.`);
  expect(ws.sent.find((m) => m.t === "tool_bridge")).toMatchObject({ op: "clipboard_write", arg: "copied", turn: 7 });
  expect(ws.sent.some((m) => m.t === "need_frame")).toBe(true);
  expect(readNotes().map((n) => n.text)).toEqual(["Likes tea."]);
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
  expect(remembered).toBe("Remembered.");
  expect(looked).toMatch(/^The user's camera, right now.* image$/);
  // Reported as the built-in brain's would be: each tool under its group, the agent's own beside them.
  expect(["t_clipboard", "t_memory", "t_look", "interrupted"].map(total)).toEqual([1, 1, 1, 0]);
  expect(callFacts()).toContainEqual({ camera_used: true });
  expect(callFacts().at(-1)).toMatchObject({ brain_kind: "acp", brain_id: "codex", turns: 1, lang: "en", agent_tools: 1, agent_start_ms: expect.any(Number) });
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);

test("a coding agent is told what the built-in brain remembered", async () => {
  const prompts = await stubAgent();
  await updateMemory(() => ["Their name is Sam."]);
  const { ws, say, done, started } = connect("call-notes");
  await started;
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(prompts().at(-1)!.text).toContain("- Their name is Sam.");
  ws.emit("close");
}, 20_000);

test("a coding agent hears on its next turn that a switch changed OpenLive's tools", async () => {
  const { setGroupEnabled } = await import("../capabilities/groups.ts");
  const prompts = await stubAgent();
  const { ws, say, done, started } = connect("call-switch");
  await started;
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(prompts().at(-1)!.text).not.toContain("tools changed");
  await setGroupEnabled("reminders", false);
  try {
    ws.sent.length = 0;
    say({ t: "user_text", text: "Again." });
    await done();
    const told = /\[OpenLive's own tools changed\. They are now: ([^\]]*?)\. If/.exec(prompts().at(-1)!.text)?.[1] ?? "";
    expect(told).toContain("remember");
    expect(told).not.toContain("set_timer");
  } finally { await setGroupEnabled("reminders", true); }
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
  expect(["perm_asks", "perm_denied", "perm_allowed", "perm_timeout"].map(total)).toEqual([1, 1, 0, 0]);
  expect(allAccepted()).toBe(true);
  expect(ws.sent.filter((m) => m.event?.type === "text_delta").map((m) => m.event.text).join("")).toBe("declined");
  // The rejection settles a card nobody sees, so it stays unseen.
  expect(ws.sent.some((m) => m.event?.type === "acp_tool_call" || m.event?.type === "acp_tool_update")).toBe(false);
  ws.emit("close");
}, 20_000);

test("a resumed session replays OpenLive's tools as it showed them live", async () => {
  await stubAgent();
  const { ws, say, done, started } = connect("call-replay", "codex", "old");
  await started;
  while (!ws.sent.some((m) => m.t === "reload_history")) await new Promise((r) => setTimeout(r, 10));
  const blocks = listMessages("call-replay").flatMap((m) => m.content);
  expect(blocks.filter((b) => b.type === "acp_tool").map((b) => b.type === "acp_tool" && b.call.id)).toEqual(["own"]);
  expect(blocks.some((b) => b.type === "text" && b.text === "A cup.")).toBe(true);
  // The agent came up in the lobby, before the call's record exists, so main
  // would drop the fact; it rides in with the first turn instead.
  expect(callFacts().some((f) => "resumed" in f)).toBe(false);
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(callFacts().filter((f) => f.turns)).toMatchObject([{ resumed: "loaded" }]);
  expect(allAccepted()).toBe(true);
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
  // The built-in brain reports the same tool under the same group, and starts no agent.
  expect(total("t_open_url")).toBe(1);
  expect(callFacts().at(-1)).toMatchObject({ brain_kind: "api", brain_id: "ollama", turns: 1, agent_start_ms: 0, ttft_ms: expect.any(Number), turn_ms: expect.any(Number) });
  expect(callFacts().some((f) => "resumed" in f)).toBe(false);
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);

/** A local OpenAI Responses stub, reached as the keyless Ollama provider: it
 *  calls `name` with `args` once, then says "Done." */
async function modelCalling(name: string, args: Record<string, unknown>) {
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const events = body.includes("function_call_output")
        ? [{ type: "response.output_text.delta", delta: "Done." }]
        : [{ type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "c1", name } },
          { type: "response.function_call_arguments.delta", item_id: "fc", delta: JSON.stringify(args) },
          { type: "response.function_call_arguments.done", item_id: "fc" }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([...events, { type: "response.completed", response: {} }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  await setSetting("liveProviderId", "ollama");
  await setSetting("liveModel", "stub");
  await setSetting("ollamaBaseUrl", `http://127.0.0.1:${(model.address() as AddressInfo).port}`);
  return model;
}

test("on the desktop a call reaches the machine, and asks before a command runs", async () => {
  const model = await modelCalling("shell", { command: "ls" });
  const { ws, say, done, started } = connect("call-device", null, undefined, true);
  (ws as any).send = ((send) => (raw: string) => {
    send(raw);
    const m = JSON.parse(raw);
    if (m.t === "permission") queueMicrotask(() => say({ t: "permission_response", reqId: m.reqId, optionId: "deny" }));
  })((ws as any).send);
  await started;
  say({ t: "user_text", text: "List my home folder.", turn: 4 });
  await done();
  model.close();
  expect(ws.sent.find((m) => m.t === "permission")).toMatchObject({ question: "OpenLive wants to run this command: ls. Allow it?", turn: 4 });
  // Refused before it reached the machine.
  expect(ws.sent.some((m) => m.t === "tool_bridge" && m.op === "flow_device")).toBe(false);
  expect(["perm_asks", "perm_denied", "perm_allowed"].map(total)).toEqual([1, 1, 0]);
  expect(allAccepted()).toBe(true);
  ws.emit("close");
}, 20_000);

test("a read on the machine does not ask, and goes through the same device bridge Flow uses", async () => {
  const model = await modelCalling("list_windows", {});
  const { ws, say, done, started } = connect("call-device-read", null, undefined, true);
  await started;
  say({ t: "user_text", text: "What's open?", turn: 5 });
  await done();
  model.close();
  expect(ws.sent.some((m) => m.t === "permission")).toBe(false);
  expect(ws.sent.find((m) => m.t === "tool_bridge" && m.op === "flow_device")).toMatchObject({ arg: JSON.stringify({ fn: "windows" }), turn: 5 });
  ws.emit("close");
}, 20_000);

test("a call without the desktop offers no device tools", async () => {
  const prompts = await stubAgent();
  const { ws, say, done, started } = connect("call-web");
  await started;
  say({ t: "user_text", text: "Hi." });
  await done();
  expect(prompts().at(-1)!.text).not.toContain("screenshot");
  ws.emit("close");
}, 20_000);
