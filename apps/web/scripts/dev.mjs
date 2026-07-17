#!/usr/bin/env node
// Cross-platform `next dev` launcher. The old script used POSIX-only inline env +
// ${VAR:-default} expansion, which breaks on Windows cmd/powershell.
import { spawn } from "node:child_process";

const agentPort = process.env.AGENT_PORT ?? "8787";
const webPort = process.env.WEB_PORT ?? "3000";
const child = spawn("next", ["dev", "-p", webPort], {
  stdio: "inherit",
  shell: process.platform === "win32", // .cmd shims need a shell on Windows
  env: { ...process.env, NEXT_PUBLIC_LIVE_WS_URL: `ws://localhost:${agentPort}` },
});
child.on("exit", (code) => process.exit(code ?? 0));
