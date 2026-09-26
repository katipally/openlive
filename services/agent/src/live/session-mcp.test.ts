// A coding agent in a call gets the call's own tools over MCP: the same objects
// the built-in brain runs, answered through the same client bridge, numbered by
// the same turn, and shown the way the built-in brain's are.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-call-mcp-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession } = await import("./session.ts");
const { getSetting, setSetting } = await import("@openlive/db");

afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A stub ACP agent that, on each prompt, calls OpenLive's tools over the MCP
 *  server it was handed, reports those calls and one of its own as tool calls,
 *  and says what came back. */
async function stubAgent() {
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
    let server;
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
    new AgentSideConnection((conn) => {
      const update = (sessionId, u) => conn.sessionUpdate({ sessionId, update: u });
      return {
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        newSession: async (p) => { server = p.mcpServers[0]; return { sessionId: "s1" }; },
        loadSession: async () => ({}),
        authenticate: async () => ({}),
        cancel: async () => {},
        prompt: async (p) => {
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text: p.prompt[0].text, server: server?.name }) + "\\n");
          const mcp = new Client({ name: "stub", version: "1" });
          await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
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
  await setSetting("acpCommand:codex", `${process.execPath} ${stub}`);
  return () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; server: string });
}

/** A call as the desktop client holds it: the bridge and the camera answered. */
function connect(chatId: string) {
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
  say({ t: "bind", agentId: "codex", cwd: dir });
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
  expect(prompts()[0]!.text).toContain('a server called "openlive": look, clipboard_read, clipboard_write, open_url, remember');
  expect(ws.sent.find((m) => m.t === "tool_bridge")).toMatchObject({ op: "clipboard_write", arg: "copied", turn: 7 });
  expect(ws.sent.some((m) => m.t === "need_frame")).toBe(true);
  expect(JSON.parse(getSetting("agent_notes") ?? "[]")).toEqual(["Likes tea."]);
  // The built-in brain's chip for remember, and the agent's own tool as a card;
  // the agent's report of OpenLive's tools is not a second copy of them.
  expect(ws.sent.find((m) => m.event?.type === "tool_start")).toMatchObject({ event: { tool: "remember", summary: "Likes tea." }, turn: 7 });
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
