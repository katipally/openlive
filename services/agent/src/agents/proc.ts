import { spawn, type ChildProcess } from "node:child_process";

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
