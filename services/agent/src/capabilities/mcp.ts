import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, Server } from "@modelcontextprotocol/server";
import type { McpServerWire } from "../agents/mcp-config.js";
import { dispatchAll, type ToolSet, type ToolTally } from "./dispatch.js";
import { allowAll } from "./approval.js";
import type { Approve, ToolCtx } from "./types.js";

// A session's tools, published as MCP.
//
// The point is parity: a coding agent driving a call or Flow over ACP must see
// exactly the tools the built-in brain sees in that mode, with the same schemas
// and the same approval. That is guaranteed by construction here, because this
// serves the SAME ToolSet the session's loop runs, through the SAME dispatch
// path. There is no second tool table to drift.

/** The one server OpenLive publishes its tools as, in every mode. Every
 *  harness namespaces a tool under this, so the preambles say it out loud. */
export const MCP_SERVER_NAME = "openlive";

export interface McpOpts {
  /** What the session's profile and bridges offer, as its loop runs them. */
  tools: ToolSet;
  /** The session's bridges and the live turn's signal and context. Resolved per call,
   *  with the agent's own id for the call when it sends one (Claude Code's
   *  `claudecode/toolUseId`, its ACP toolCallId too): MCP carries no turn, so
   *  that id is all that ties a late call to the prompt that made it. */
  ctx: (agentCallId?: string) => Omit<ToolCtx, "callId">;
  approve?: Approve;
  /** Told of every call that ran. Must not throw. */
  tally?: ToolTally;
  /**
   * Every call the agent makes, for the session transcript.
   *
   * An agent brain calls these tools itself rather than through the session's loop, so
   * without this the session records what was said and nothing about what was
   * done: a turn that took ten screenshots and clicked through an app reads as
   * two sentences and "Tools: None". Must not throw.
   */
  onCall?: (event: { type: "tool_call" | "tool_result" } & Record<string, unknown>) => void;
}

/** The low-level server, not McpServer: McpServer validates arguments and names
 *  before a handler runs, which would refuse the hallucinated calls dispatch repairs. */
export function mcpServer(opts: McpOpts): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", async () => ({
    tools: opts.tools.list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" }, ...(t.readOnly && { annotations: { readOnlyHint: true } }) })),
  }));

  server.setRequestHandler("tools/call", async (req) => {
    const call = { id: randomUUID(), name: req.params.name, args: req.params.arguments ?? {} };
    opts.onCall?.({ type: "tool_call", id: call.id, name: call.name, args: call.args });
    const agentCallId = req.params._meta?.["claudecode/toolUseId"];
    const result = (await dispatchAll([call], opts.tools, opts.ctx(typeof agentCallId === "string" ? agentCallId : undefined), { approve: opts.approve ?? allowAll, tally: opts.tally }))[0]!;
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
 * Serve it on loopback for the duration of a session.
 *
 * The URL carries a random path token because a loopback port is reachable by
 * anything else on the machine, and MCP has no auth of its own here.
 *
 * Stateless: every request is answered by a fresh server from the same tools,
 * in whichever protocol era the agent speaks. There is no session to refuse a
 * second `initialize` or to be torn down by one agent's DELETE, so an agent that
 * restarts, a second session and a reconnect all get the same tools.
 */
export async function serveMcp(opts: McpOpts): Promise<{ wire: McpServerWire; close(): Promise<void> }> {
  const path = `/mcp/${randomUUID()}`;
  const handler = createMcpHandler(() => mcpServer(opts));
  const hosts = localhostAllowedHostnames();
  const fetch = (req: Request): Promise<Response> | Response => {
    if (new URL(req.url).pathname !== path) return new Response(null, { status: 404 });
    return hostHeaderValidationResponse(req, hosts) ?? handler.fetch(req);
  };
  let http!: ReturnType<typeof serve>;
  const port = await new Promise<number>((resolve) => { http = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(info.port)); });

  return {
    wire: { type: "http", name: MCP_SERVER_NAME, url: `http://127.0.0.1:${port}${path}`, headers: [] },
    close: async () => {
      await handler.close().catch(() => {});
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
