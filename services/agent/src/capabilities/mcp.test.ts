import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SERVER_NAME, mcpServer, serveMcp } from "./mcp.js";
import { toolSpecs, ToolSet } from "./dispatch.js";
import { TEXT_TOOLS } from "./text.js";
import { deviceTools } from "./device-tools.js";
import { registry } from "./registry.js";
import { CHAT, FLOW } from "./profiles.js";
import type { CapabilityReport, DevicePort, ShotGeometry } from "./device.js";
import type { Approve, ClipboardPort, InsertionSink, Session } from "./types.js";

const SHOT: ShotGeometry = { originX: 0, originY: 0, scale: 1, width: 1024, height: 768 };
const CAPS: CapabilityReport = {
  hook: true, postEvents: true, injection: "paste", capture: true, captureBackend: "test", ocr: true, ocrEngine: "test",
  selection: true, selectionBackend: "test", windowControl: true, elevatedWindowInjection: true,
  secureInput: false, tools: [],
};

const device: DevicePort = {
  capabilities: async () => CAPS,
  displays: async () => [],
  capture: async () => ({ png: "PNG", shot: SHOT }),
  shotToScreen: async (_s, p) => ({ space: "screen", x: p.x, y: p.y }),
  recognizeText: async () => [],
  windows: async () => [],
  foreground: async () => null,
  cameraFrame: async () => null,
  control: async () => {},
  shell: async () => ({ code: 0, stdout: "", stderr: "" }),
};

const insert: InsertionSink = { commit: async () => {}, end: async () => {}, abandon: async () => {}, committed: () => "" };
const clipboard: ClipboardPort = { read: async () => "on the clipboard", write: async () => {} };

/** What Flow's built-in brain runs, with no wait before the screenshot that follows an action. */
const flowTools = () => new ToolSet([...TEXT_TOOLS, ...deviceTools({ device, screenshotDelayMs: 0 })]);

async function connect(tools: ToolSet, approve?: Approve) {
  const server = mcpServer({
    tools,
    ctx: () => ({ signal: new AbortController().signal, context: null, insert, clipboard }),
    approve,
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("a session's tools over MCP", () => {
  it("publishes exactly the tool surface the built-in brain runs", async () => {
    const tools = flowTools();
    const client = await connect(tools);
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })))
      .toEqual(toolSpecs(tools.list));
  });

  it("marks the tools that only read, so Codex runs them without asking", async () => {
    const client = await connect(flowTools());
    const listed = (await client.listTools()).tools;
    const reads = listed.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(reads).toEqual(expect.arrayContaining(["screenshot", "read_screen_text", "get_context", "read_selection", "clipboard_read"]));
    for (const acts of ["click", "insert_text", "clipboard_write"]) expect(reads).not.toContain(acts);
  });

  it("runs a call through the same dispatch, images and all", async () => {
    const client = await connect(flowTools());
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(r.isError).toBe(false);
    expect(r.content).toContainEqual({ type: "image", data: "PNG", mimeType: "image/png" });
  });

  it("repairs a hallucinated call the same way the built-in brain does", async () => {
    const client = await connect(flowTools());
    await client.callTool({ name: "screenshot", arguments: {} });
    const r = await client.callTool({ name: "left_click", arguments: { coordinate: [12, 34] } });
    expect(r.isError).toBe(false);
  });

  it("hands the host the agent's own id for a call, so a call from a stopped prompt can be refused", async () => {
    const dead = new Set(["toolu_old"]);
    const server = mcpServer({
      tools: flowTools(),
      ctx: (agentCallId) => ({ signal: agentCallId && dead.has(agentCallId) ? AbortSignal.abort() : new AbortController().signal, context: null, insert, clipboard }),
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const late = await client.callTool({ name: "screenshot", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_old" } });
    expect(late.isError).toBe(true);
    const live = await client.callTool({ name: "screenshot", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_new" } });
    expect(live.isError).toBe(false);
  });

  it("applies the same approval hook, so a blocked tool is blocked for both brains", async () => {
    const client = await connect(flowTools(), async () => ({ block: true, reason: "the user said no" }));
    const r = await client.callTool({ name: "shell", arguments: { command: "rm -rf /" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("the user said no");
  });
});

describe("one server for every mode", () => {
  const listed = async (s: Session, profile: typeof CHAT | typeof FLOW) => (await (await connect(registry.tools(profile, s))).listTools()).tools.map((t) => t.name);
  const chat: Session = { clipboard, openUrl: async () => "Opened.", share: { showing: () => null, frame: async () => null }, workspace: () => "/tmp" };
  const flowSession: Session = { foreground: { capture: async () => null }, insert, clipboard, device };

  it("is called openlive in a call and in Flow", async () => {
    const served = await serveMcp({ tools: registry.tools(FLOW, flowSession), ctx: () => ({ signal: new AbortController().signal, context: null }) });
    expect(served.wire.name).toBe(MCP_SERVER_NAME);
    expect(MCP_SERVER_NAME).toBe("openlive");
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(served.wire.url!)));
    expect(client.getServerVersion()?.name).toBe("openlive");
    await client.close();
    await served.close();
  });

  it("serves exactly the tools the session's profile and bridges give its built-in brain", async () => {
    for (const [s, profile] of [[chat, CHAT], [flowSession, FLOW]] as const) {
      expect(await listed(s, profile)).toEqual(registry.tools(profile, s).list.map((t) => t.name));
    }
  });

  it("leaves out what the session cannot reach", async () => {
    const call = await listed(chat, CHAT);
    expect(call).toEqual(expect.arrayContaining(["look", "list_dir", "open_url", "delegate", "remember"]));
    for (const absent of ["insert_text", "get_context", "screenshot", "shell"]) expect(call).not.toContain(absent);
    const flow = await listed(flowSession, FLOW);
    expect(flow).toEqual(expect.arrayContaining(["insert_text", "screenshot", "shell", "delegate", "update_todos", "remember"]));
    for (const absent of ["look", "list_dir", "write_file"]) expect(flow).not.toContain(absent);
  });

  it("gives a call with the device the same device tools as Flow", async () => {
    const call = await listed({ ...chat, device }, CHAT);
    const flow = await listed(flowSession, FLOW);
    for (const name of ["screenshot", "click", "keypress", "shell", "open_url", "camera_frame"]) {
      expect(call).toContain(name);
      expect(flow).toContain(name);
    }
  });
});

// The wire is a separate thing from the server: an ACP agent reaches Flow over
// loopback HTTP, and a streamable-HTTP MCP server is stateful. One shared
// server answers exactly one agent and refuses everything after it with
// "Server already initialized" — which the agent reports to the user as having
// no tools at all. These are the two shapes that happen in practice: an agent
// that restarts, and two Flow sessions at once.
describe("the wire an ACP agent connects to", () => {
  const serve = () => serveMcp({
    tools: flowTools(),
    ctx: () => ({ signal: new AbortController().signal, context: null, insert, clipboard }),
  });
  const join = async (url: string, name: string) => {
    const client = new Client({ name, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  };

  it("still has tools for the agent that reconnects after the first one left", async () => {
    const served = await serve();
    const first = await join(served.wire.url!, "first");
    expect((await first.listTools()).tools.length).toBeGreaterThan(0);
    await first.close();

    const second = await join(served.wire.url!, "second");
    expect((await second.listTools()).tools.map((t) => t.name)).toContain("screenshot");
    await second.close();
    await served.close();
  });

  it("serves two agents at once", async () => {
    const served = await serve();
    const [a, b] = await Promise.all([join(served.wire.url!, "a"), join(served.wire.url!, "b")]);
    const [toolsA, toolsB] = await Promise.all([a.listTools(), b.listTools()]);
    expect(toolsA.tools.length).toEqual(toolsB.tools.length);
    expect(toolsA.tools.length).toBeGreaterThan(0);
    await Promise.all([a.close(), b.close()]);
    await served.close();
  });

  it("tells the session what the agent did, not only what it said", async () => {
    const seen: Array<{ type: string; name?: unknown }> = [];
    const served = await serveMcp({
      tools: flowTools(),
      ctx: () => ({ signal: new AbortController().signal, context: null, insert, clipboard }),
      onCall: (event) => { seen.push({ type: event.type, name: event.name }); },
    });
    const agent = await join(served.wire.url!, "agent");
    await agent.callTool({ name: "screenshot", arguments: {} });
    expect(seen).toEqual([
      { type: "tool_call", name: "screenshot" },
      { type: "tool_result", name: "screenshot" },
    ]);
    await agent.close();
    await served.close();
  });

  it("turns away a request that is not an agent opening a session", async () => {
    const served = await serve();
    const r = await fetch(served.wire.url!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.ok).toBe(false);
    await served.close();
  });
});
