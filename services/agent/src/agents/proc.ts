import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// Every spawned tree still running. A detached child outlives the agent, and in
// the desktop app the agent is a utility process with no process group for the
// app to kill, so the agent's own exit has to take them down.
const running = new Set<ChildProcess>();
export function track(child: ChildProcess): void {
  running.add(child);
  child.once("exit", () => running.delete(child));
}
process.once("exit", () => {
  for (const { pid } of running) {
    if (!pid) continue;
    // Only synchronous work runs in an exit handler.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } }
  }
});

// Kill a spawned child AND its whole descendant tree. POSIX children are
// spawned detached (own process group) so the negative-pid kill reaches
// grandchildren (npx → node → binary); Windows uses taskkill /T.
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { try { child.kill(); } catch { /* already dead */ } }
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { child.kill("SIGTERM"); } catch { /* already dead */ } }
    // Escalate if it ignores SIGTERM, so a stuck process can't linger.
    setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 2000).unref();
  }
}
