#!/usr/bin/env node
// Free dev ports before starting — kills stale listeners left by a crashed/Ctrl+C'd
// run so the next start never hits EADDRINUSE. Cross-platform (Windows has no lsof).
//
// Usage: node free-ports.mjs [--sweep] [port...]
//   ports  default to WEB_PORT/AGENT_PORT env (else 3000/8787) when none are given.
//   --sweep also kills leftover repo-scoped dev supervisors (tsx watch / next /
//           electron) that linger WITHOUT holding a port — the "empty processes"
//           that pile up across desktop:dev runs. POSIX only (see note below).
// ponytail: lsof/netstat + kill; swap for a process manager only if this isn't enough.
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const sweep = argv.includes("--sweep");
const ports = argv.filter((a) => /^\d+$/.test(a));
if (ports.length === 0) ports.push(process.env.WEB_PORT ?? "3000", process.env.AGENT_PORT ?? "8787");

const isWin = process.platform === "win32";
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }); } catch { return ""; } };

function pidsOnPort(port) {
  if (isWin) {
    // Match the local address's port EXACTLY. A naive `findstr :3000` also matches
    // :30001 etc. Columns: proto | local | foreign | state | pid.
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

// /T on Windows kills the child's tree too (next-server under `next`, etc.).
const kill = (pid, force) => sh(isWin
  ? `taskkill ${force ? "/F " : ""}/T /PID ${pid}`
  : `kill ${force ? "-9 " : ""}${pid}`);

let killed = false;
for (const port of ports) for (const pid of pidsOnPort(port)) {
  console.log(`  port ${port} busy -> killing pid ${pid}`);
  kill(pid, false); killed = true;
}

// Sweep idle leftover supervisors from a prior run that no longer hold a port (a
// `tsx watch` whose server child was already killed still lingers as a parent).
// Scoped to THIS repo's path so we never touch another project or the editor.
// POSIX-only: killing the port holder above with taskkill /T already reaps the tree
// on Windows, and its command-line query differs enough to not be worth the code.
if (sweep && !isWin) {
  const root = process.cwd();
  for (const line of sh("ps ax -o pid=,command=").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), cmd = m[2];
    if (pid === process.pid || !cmd.includes(root)) continue;
    if (/Visual Studio Code|Code Helper/.test(cmd)) continue;
    if (/\b(tsx|next|electron|esbuild|concurrently)\b/i.test(cmd)) {
      console.log(`  sweeping repo orphan pid ${pid}`);
      sh(`kill -9 ${pid}`); killed = true;
    }
  }
}

if (killed) {
  await new Promise((r) => setTimeout(r, 800));
  for (const port of ports) for (const pid of pidsOnPort(port)) { console.log(`  port ${port} still busy -> force kill ${pid}`); kill(pid, true); }
  console.log(`  freed ports (${ports.join(" ")})${sweep ? " + swept repo orphans" : ""}`);
}
