import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { flowMcpServer } from "./mcp.js";
import { flowTools, toolSpecs } from "./tools.js";
import type { CapabilityReport, DevicePort, ShotGeometry } from "./device.js";
import type { Approve, ClipboardPort, InsertionSink, Tool } from "./types.js";

const SHOT: ShotGeometry = { originX: 0, originY: 0, scale: 1, width: 1024, height: 768 };
const CAPS: CapabilityReport = {
  hook: true, injection: "paste", capture: true, captureBackend: "test", ocr: true, ocrEngine: "test",
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

const insert: InsertionSink = { commit: async () => {}, end: async () => {} };
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
