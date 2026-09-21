import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerWire } from "../agents/mcp-config.js";
import { dispatch, toolSpecs } from "./tools.js";
import { allowAll } from "./approval.js";
import type { Approve, Tool, ToolCtx } from "./types.js";

// Flow's tool set, published as MCP.
//
// The point is parity: a coding agent driving Flow over ACP must see exactly the
// tools the built-in brain sees, with the same schemas and the same risk gating.
// That is guaranteed by construction here, because this serves the SAME `Tool[]`
// through the SAME dispatch path. There is no second tool table to drift.

export interface FlowMcpOpts {
  tools: Tool[];
  /** The live turn's context, insertion sink and clipboard. Resolved per call. */
  ctx: () => Omit<ToolCtx, "callId">;
  approve?: Approve;
}

export function flowMcpServer(opts: FlowMcpOpts): Server {
  const server = new Server({ name: "openlive-flow", version: "1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolSpecs(opts.tools).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const call = { id: randomUUID(), name: req.params.name, args: req.params.arguments ?? {} };
    const running = dispatch([call], opts.tools, opts.ctx(), { approve: opts.approve ?? allowAll });
    let step = await running.next();
    while (!step.done) step = await running.next();
    const result = step.value[0]!;
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
 */
export async function serveFlowMcp(opts: FlowMcpOpts): Promise<{ wire: McpServerWire; close(): Promise<void> }> {
  const server = flowMcpServer(opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const path = `/mcp/${randomUUID()}`;
  const http: HttpServer = createServer((req, res) => {
    if (!req.url?.startsWith(path)) { res.writeHead(404).end(); return; }
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    wire: { type: "http", name: "openlive-flow", url: `http://127.0.0.1:${port}${path}`, headers: [] },
    close: async () => {
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
