import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerWire } from "../agents/mcp-config.js";
import { dispatch, toolSpecs } from "./tools.js";
import { allowAll } from "./approval.js";
import { MCP_SERVER_NAME, type Approve, type Tool, type ToolCtx } from "./types.js";

// Flow's tool set, published as MCP.
//
// The point is parity: a coding agent driving Flow over ACP must see exactly the
// tools the built-in brain sees, with the same schemas and the same risk gating.
// That is guaranteed by construction here, because this serves the SAME `Tool[]`
// through the SAME dispatch path. There is no second tool table to drift.

/** An opening MCP request is small; anything larger is not one. */
const MAX_BODY_BYTES = 1_000_000;

export interface FlowMcpOpts {
  tools: Tool[];
  /** The live turn's context, insertion sink and clipboard. Resolved per call. */
  ctx: () => Omit<ToolCtx, "callId">;
  approve?: Approve;
  /**
   * Every call the agent makes, for the session transcript.
   *
   * An agent brain calls these tools itself rather than through Flow's loop, so
   * without this the session records what was said and nothing about what was
   * done: a turn that took ten screenshots and clicked through an app reads as
   * two sentences and "Tools: None". Must not throw.
   */
  onCall?: (event: { type: "tool_call" | "tool_result" } & Record<string, unknown>) => void;
}

export function flowMcpServer(opts: FlowMcpOpts): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolSpecs(opts.tools).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const call = { id: randomUUID(), name: req.params.name, args: req.params.arguments ?? {} };
    opts.onCall?.({ type: "tool_call", id: call.id, name: call.name, args: call.args });
    const running = dispatch([call], opts.tools, opts.ctx(), { approve: opts.approve ?? allowAll });
    let step = await running.next();
    while (!step.done) step = await running.next();
    const result = step.value[0]!;
    opts.onCall?.({ type: "tool_result", id: result.id, name: result.name, content: result.content, isError: result.isError });
    return {
      isError: result.isError,
      content: result.content.map((c) => (c.type === "text"
        ? { type: "text" as const, text: c.text }
        : { type: "image" as const, data: c.data, mimeType: c.mime })),
    };
  });

  return server;
}

/**
 * Serve it on loopback for the duration of a Flow session.
 *
 * The URL carries a random path token because a loopback port is reachable by
 * anything else on the machine, and MCP has no auth of its own here.
 *
 * One server per connection, not one for the whole port. A streamable-HTTP MCP
 * server is stateful: it refuses a second `initialize` with "Server already
 * initialized", and it is torn down by the DELETE a client sends when its
 * session ends. Sharing one across connections therefore works exactly once —
 * the first agent gets the tools, and every agent after it (a supervisor
 * restart, a second Flow session, a reconnect) is turned away and reports that
 * it has no tools at all.
 */
export async function serveFlowMcp(opts: FlowMcpOpts): Promise<{ wire: McpServerWire; close(): Promise<void> }> {
  const path = `/mcp/${randomUUID()}`;
  const live = new Map<string, StreamableHTTPServerTransport>();

  /** A connection of its own, remembered by the session id it is handed. */
  const open = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { live.set(id, transport); },
    });
    transport.onclose = () => { if (transport.sessionId) live.delete(transport.sessionId); };
    await flowMcpServer(opts).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      try {
        if (!req.url?.startsWith(path)) { res.writeHead(404).end(); return; }
        const id = req.headers["mcp-session-id"];
        const known = typeof id === "string" ? live.get(id) : undefined;
        if (known) { await known.handleRequest(req, res); return; }
        // A GET or DELETE naming a session that is gone is an agent talking to
        // a connection it already ended; only an opening POST starts a new one.
        const body = req.method === "POST" ? await readJson(req) : undefined;
        if (!isInitializeRequest(body)) { res.writeHead(id ? 404 : 400).end(); return; }
        await open(req, res, body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    wire: { type: "http", name: MCP_SERVER_NAME, url: `http://127.0.0.1:${port}${path}`, headers: [] },
    close: async () => {
      await Promise.all([...live.values()].map((t) => t.close().catch(() => {})));
      live.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** The body, or undefined when it is not JSON. Reading it here is what lets an
 *  opening request be told apart from a stray one before a server is built for it. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return undefined; }
}
