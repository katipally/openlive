import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flowMcpServer, serveFlowMcp } from "./mcp.js";
import { flowTools, toolSpecs } from "./tools.js";
import type { CapabilityReport, DevicePort, ShotGeometry } from "./device.js";
import type { Approve, ClipboardPort, InsertionSink, Tool } from "./types.js";

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

async function connect(tools: Tool[], approve?: Approve) {
  const server = flowMcpServer({
    tools,
    ctx: () => ({ signal: new AbortController().signal, context: null, insert, clipboard }),
    approve,
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("Flow over MCP", () => {
  it("publishes exactly the tool surface the built-in brain runs", async () => {
    const tools = flowTools({ device, screenshotDelayMs: 0 });
    const client = await connect(tools);
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })))
      .toEqual(toolSpecs(tools));
  });

  it("runs a call through the same dispatch, images and all", async () => {
    const client = await connect(flowTools({ device, screenshotDelayMs: 0 }));
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(r.isError).toBe(false);
    expect(r.content).toContainEqual({ type: "image", data: "PNG", mimeType: "image/png" });
  });

  it("repairs a hallucinated call the same way the built-in brain does", async () => {
    const client = await connect(flowTools({ device, screenshotDelayMs: 0 }));
    await client.callTool({ name: "screenshot", arguments: {} });
    const r = await client.callTool({ name: "left_click", arguments: { coordinate: [12, 34] } });
    expect(r.isError).toBe(false);
  });

  it("applies the same approval hook, so a blocked tool is blocked for both brains", async () => {
    const client = await connect(flowTools({ device, screenshotDelayMs: 0 }), async () => ({ block: true, reason: "the user said no" }));
    const r = await client.callTool({ name: "shell", arguments: { command: "rm -rf /" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("the user said no");
  });
});

// The wire is a separate thing from the server: an ACP agent reaches Flow over
// loopback HTTP, and a streamable-HTTP MCP server is stateful. One shared
// server answers exactly one agent and refuses everything after it with
// "Server already initialized" — which the agent reports to the user as having
// no tools at all. These are the two shapes that happen in practice: an agent
// that restarts, and two Flow sessions at once.
describe("the wire an ACP agent connects to", () => {
  const serve = () => serveFlowMcp({
    tools: flowTools({ device, screenshotDelayMs: 0 }),
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
    const served = await serveFlowMcp({
      tools: flowTools({ device, screenshotDelayMs: 0 }),
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
