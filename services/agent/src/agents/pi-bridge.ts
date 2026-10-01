import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerWire } from "./mcp-config.js";

type HttpServer = Extract<McpServerWire, { type: "http" }>;

export interface PiBridge { servers: HttpServer[]; env: Record<string, string>; dispose(): void }

// pi-acp drops session/new mcpServers by design (svkozak/pi-acp#67), but it runs pi as
// $PI_ACP_PI_COMMAND, and pi (0.99+) lets an `-e` extension register MCP servers. So the
// session gets a private folder holding a launcher that adds `-e`, and an extension that
// registers OpenLive's servers. ~/.pi and the project stay untouched, and the URL with its
// token lives only in that folder (0700 from mkdtemp), removed when the session ends.
export function piBridge(servers: HttpServer[]): PiBridge {
  const dir = mkdtempSync(join(tmpdir(), "openlive-pi-"));
  writeFileSync(join(dir, "openlive.js"), extension(servers), { mode: 0o600 });
  const win = process.platform === "win32";
  const launcher = join(dir, win ? "openlive-pi.cmd" : "openlive-pi");
  writeFileSync(launcher, win
    ? `@echo off\r\npi -e "%~dp0openlive.js" %*\r\n`
    : `#!/bin/sh\nexec pi -e "$(dirname "$0")/openlive.js" "$@"\n`, { mode: 0o700 });
  return { servers, env: { PI_ACP_PI_COMMAND: launcher }, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// `direct` exposure: pi declares the tools to the model without a search, and titles each
// call `mcp__<server>__<tool>`, which is how OpenLive tells its own tools' calls apart.
function extension(servers: HttpServer[]): string {
  const config = servers.map((s) => ({ name: s.name, url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) }));
  return `const servers = ${JSON.stringify(config)};
export default function (pi) {
  if (!pi.registerMcpServer) throw new Error("OpenLive's tools need pi 0.99 or newer");
  for (const s of servers) pi.registerMcpServer(s.name, { url: s.url, headers: s.headers, exposure: "direct" });
}
`;
}
