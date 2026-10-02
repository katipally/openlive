// End to end against a real stdio MCP server: the store, one shared connection,
// the registry provider, and an ACP-style agent reaching the connector only
// through OpenLive's own MCP server.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as AgentClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as AgentTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = mkdtempSync(join(tmpdir(), "ol-connectors-"));
process.env.OPENLIVE_HOME = dir;
process.env.OPENLIVE_ENC_KEY = "cd".repeat(32);
const db = await import("@openlive/db");
const { ConnectorManager, ConsentRequired } = await import("./manager.ts");
const { connectorTools } = await import("./tools.ts");
const { ToolRegistry } = await import("../capabilities/registry.ts");
const { serveMcp } = await import("../capabilities/mcp.ts");
const { CHAT } = await import("../capabilities/profiles.ts");

const fixture = fileURLToPath(new URL("./fixture-server.fixture.mjs", import.meta.url));
const pids = join(dir, "pids");
const manager = new ConnectorManager();
const registry = new ToolRegistry();
registry.register(connectorTools(manager));
let id = "";

beforeAll(async () => {
  const row = await db.createConnector({
    name: "Fixture",
    transport: { type: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_PID_FILE: pids }, secretEnv: { FIXTURE_SECRET: "s3cret" } },
  });
  id = row.id;
});
afterAll(async () => {
  await manager.shutdown();
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_ENC_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const names = () => registry.tools(CHAT, {}).list.map((t) => t.name);
const started = () => readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number);

/** An agent session as an ACP agent sees it: OpenLive's MCP server, nothing else. */
async function agentSession(elicit?: (r: unknown) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>) {
  const served = await serveMcp({ tools: registry.tools(CHAT, {}), ctx: () => ({ signal: new AbortController().signal, context: null, ...(elicit && { elicit }) }) });
  const agent = new AgentClient({ name: "agent", version: "1" });
  await agent.connect(new AgentTransport(new URL(served.wire.url!)));
  return { agent, done: async () => { await agent.close(); await served.close(); } };
}

describe("a stdio connector", () => {
  it("never starts before the person agrees to run it", async () => {
    expect(manager.status(db.getConnectorRow(id)!).status).toBe("needs_consent");
    await expect(manager.client(id)).rejects.toBeInstanceOf(ConsentRequired);
    expect(names()).toEqual([]);
  });

  it("lists its tools once allowed, namespaced, read-only only where the server says so", async () => {
    await db.consentToSpawn(id);
    await manager.client(id);
    expect(manager.status(db.getConnectorRow(id)!).status).toBe("connected");
    const tools = registry.tools(CHAT, {}).list;
    expect(tools.map((t) => t.name)).toEqual(["fixture__echo", "fixture__make_note", "fixture__confirm"]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.fixture__echo!.readOnly).toBe(true);
    expect(by.fixture__echo!.confirm).toBeUndefined();
    expect(by.fixture__make_note!.readOnly).toBe(false);
    expect(by.fixture__make_note!.confirm?.({})).toBe("use Fixture: make.note");
    expect(by.fixture__echo!.parameters).toMatchObject({ type: "object", required: ["text"] });
  });

  it("is reached by an agent only through OpenLive's MCP server, with its secret env applied", async () => {
    const { agent, done } = await agentSession();
    const r = await agent.callTool({ name: "fixture__echo", arguments: { text: "hi" } });
    expect(r.content).toEqual([{ type: "text", text: "echo: hi (s3cret)" }]);
    const note = await agent.callTool({ name: "fixture__make_note", arguments: { title: "t" } });
    expect(note.content).toEqual([
      { type: "text", text: "noted t" },
      { type: "image", data: "UE5H", mimeType: "image/png" },
      { type: "text", text: "Resource: 1.md, the note <file:///notes/1.md>" },
    ]);
    await done();
  });

  it("runs one copy for every session", async () => {
    const a = await agentSession();
    const b = await agentSession();
    await Promise.all([a.agent.callTool({ name: "fixture__echo", arguments: { text: "a" } }), b.agent.callTool({ name: "fixture__echo", arguments: { text: "b" } })]);
    await Promise.all([a.done(), b.done()]);
    expect(started()).toHaveLength(1);
  });

  it("puts a server's question to the session whose call asked it", async () => {
    const asked: unknown[] = [];
    const { agent, done } = await agentSession(async (req) => { asked.push(req); return { action: "accept", content: { sure: true } }; });
    const r = await agent.callTool({ name: "fixture__confirm", arguments: {} });
    expect(r.content).toEqual([{ type: "text", text: "sure=true" }]);
    expect(asked).toEqual([expect.objectContaining({ mode: "form", message: "Go ahead?" })]);
    await done();
  });

  it("asks a session running two calls at once, and never guesses between two sessions", async () => {
    const asked: string[] = [];
    const ask = (who: string, sure: boolean) => async () => { asked.push(who); await new Promise((r) => setTimeout(r, 50)); return { action: "accept" as const, content: { sure } }; };
    const one = await agentSession(ask("one", true));
    const both = await Promise.all([1, 2].map(() => one.agent.callTool({ name: "fixture__confirm", arguments: {} })));
    expect(both.map((r) => r.content)).toEqual([[{ type: "text", text: "sure=true" }], [{ type: "text", text: "sure=true" }]]);
    const a = await agentSession(ask("a", false));
    const b = await agentSession(ask("b", true));
    // stdio names no call, so with two sessions waiting neither is asked.
    const [ra, rb] = await Promise.all([a.agent.callTool({ name: "fixture__confirm", arguments: {} }), b.agent.callTool({ name: "fixture__confirm", arguments: {} })]);
    expect([ra.isError, rb.isError]).toEqual([true, true]);
    expect(asked).toEqual(["one", "one"]);
    await Promise.all([one.done(), a.done(), b.done()]);
  });

  it("declines a form where the session cannot show one", async () => {
    const { agent, done } = await agentSession();
    const r = await agent.callTool({ name: "fixture__confirm", arguments: {} });
    expect(r.isError).toBe(true);
    await done();
  });

  it("leaves out a tool switched off, and every tool of a connector switched off", async () => {
    await db.setConnectorToolsEnabled(id, ["make.note"], false);
    expect(names()).toEqual(["fixture__echo", "fixture__confirm"]);
    await db.updateConnector(id, { enabled: false });
    expect(names()).toEqual([]);
    await db.updateConnector(id, { enabled: true });
  });

  it("comes back on its own after its server dies", async () => {
    process.kill(started()[0]!, "SIGKILL");
    const deadline = Date.now() + 8000;
    while (started().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(started()).toHaveLength(2);
    await manager.client(id);
    expect(manager.status(db.getConnectorRow(id)!).status).toBe("connected");
  });

  it("ends its child at shutdown", async () => {
    const pid = started().at(-1);
    await manager.shutdown();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});

describe("an http connector", () => {
  it("puts each question to the session whose call asked, when two ask at once", async () => {
    const { Server, inputRequired, acceptedContent, createMcpHandler } = await import("@modelcontextprotocol/server");
    const { serve } = await import("@hono/node-server");
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "remote", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "confirm", description: "Ask first.", inputSchema: { type: "object", properties: {} } }] }));
      server.setRequestHandler("tools/call", async (_req, ctx) => {
        const answer = acceptedContent(ctx.mcpReq.inputResponses, "ok");
        if (!answer) return inputRequired({ inputRequests: { ok: inputRequired.elicit({ message: "Go ahead?", requestedSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] } }) } });
        return { content: [{ type: "text", text: `who=${answer.who}` }] };
      });
      return server;
    });
    let http!: ReturnType<typeof serve>;
    const port = await new Promise<number>((resolve) => { http = serve({ fetch: (req) => handler.fetch(req), port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port)); });
    const own = new ConnectorManager();
    const row = await db.createConnector({ name: "Remote", transport: { type: "http", url: `http://127.0.0.1:${port}/mcp` } });
    try {
      const caller = (who: string, ms: number) => ({
        signal: new AbortController().signal,
        elicit: async () => { await new Promise((r) => setTimeout(r, ms)); return { action: "accept" as const, content: { who } }; },
      });
      const [a, b] = await Promise.all([own.call(row.id, "confirm", {}, caller("a", 80)), own.call(row.id, "confirm", {}, caller("b", 0))]);
      expect([a.content, b.content]).toEqual([[{ type: "text", text: "who=a" }], [{ type: "text", text: "who=b" }]]);
    } finally {
      await own.shutdown();
      await handler.close().catch(() => {});
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
