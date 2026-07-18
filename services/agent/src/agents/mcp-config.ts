import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

// Read the project's `.mcp.json` (the Claude Code convention other agents also
// understand) and shape it for ACP session/new + session/load `mcpServers`.
// Best-effort by design: a missing or malformed file must NEVER fail the
// handshake — the agent just starts without passthrough servers.

const MAX_SERVERS = 20;

type McpJsonEntry = {
  type?: string;               // "stdio" (default) | "http" | "sse"
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type McpServerWire =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> };

/** Which transports the agent accepts, from its initialize response. Stdio is
 *  part of the base spec; http/sse are capability-gated. */
export function readProjectMcpServers(cwd: string, init: { agentCapabilities?: { mcpCapabilities?: { http?: boolean | null; sse?: boolean | null } | null } | null }): McpServerWire[] {
  let raw: string;
  try { raw = readFileSync(join(cwd, ".mcp.json"), "utf8"); }
  catch { return []; } // no file — the common case
  return parseMcpJson(raw, {
    http: !!init.agentCapabilities?.mcpCapabilities?.http,
    sse: !!init.agentCapabilities?.mcpCapabilities?.sse,
  });
}

/** Pure parser (unit-tested with fixture strings). */
export function parseMcpJson(raw: string, caps: { http: boolean; sse: boolean }): McpServerWire[] {
  let json: { mcpServers?: Record<string, McpJsonEntry> };
  try { json = JSON.parse(raw) as typeof json; }
  catch (e) { log.debug("mcp", `.mcp.json unreadable: ${String(e)}`); return []; }
  const entries = Object.entries(json?.mcpServers ?? {});
  const out: McpServerWire[] = [];
  for (const [name, s] of entries) {
    if (out.length >= MAX_SERVERS) { log.debug("mcp", `.mcp.json: over ${MAX_SERVERS} servers — rest skipped`); break; }
    if (!s || typeof s !== "object") continue;
    const type = s.type ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
    if (type === "stdio" && typeof s.command === "string" && s.command) {
      out.push({
        name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [],
        env: Object.entries(s.env ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
      });
    } else if ((type === "http" || type === "sse") && typeof s.url === "string" && s.url) {
      if (!caps[type]) { log.debug("mcp", `.mcp.json: "${name}" is ${type} but the agent doesn't accept ${type} MCP — skipped`); continue; }
      out.push({
        type,
        name,
        url: s.url,
        headers: Object.entries(s.headers ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
      });
    }
  }
  return out;
}
