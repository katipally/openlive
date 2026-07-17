#!/usr/bin/env node
// Free the dev ports before starting — kills stale listeners left by a crashed run.
// Cross-platform replacement for the old free-ports.sh (Windows has no bash/lsof).
// ponytail: lsof/netstat + kill; swap for a process manager only if this ever isn't enough.
import { execSync } from "node:child_process";

const ports = [process.env.WEB_PORT ?? "3000", process.env.AGENT_PORT ?? "8787"];
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }); } catch { return ""; } };

function pidsOnPort(port) {
  if (process.platform === "win32") {
    // Parse netstat columns and match the local address's port EXACTLY. A naive
    // `findstr :3000` also matches :30001, :30002, … and would taskkill unrelated
    // processes. Columns: proto | local | foreign | state | pid.
    const pids = new Set();
    for (const line of sh("netstat -ano -p tcp").split("\n")) {
      const c = line.trim().split(/\s+/);
      if (c.length < 5 || c[3] !== "LISTENING") continue;
      if (c[1].endsWith(`:${port}`) && c[4] && c[4] !== "0") pids.add(c[4]);
    }
    return [...pids];
  }
  return sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split("\n").filter(Boolean);
}

const kill = (pid, force) => sh(process.platform === "win32"
  ? `taskkill ${force ? "/F " : ""}/PID ${pid}`
  : `kill ${force ? "-9 " : ""}${pid}`);

let killed = false;
for (const port of ports) {
  for (const pid of pidsOnPort(port)) {
    console.log(`  port ${port} busy -> killing pid ${pid}`);
    kill(pid, false);
    killed = true;
  }
}
if (killed) {
  await new Promise((r) => setTimeout(r, 1000));
  for (const port of ports) for (const pid of pidsOnPort(port)) { console.log(`  port ${port} still busy -> force kill ${pid}`); kill(pid, true); }
  console.log(`  freed dev ports (${ports.join(" ")})`);
}
