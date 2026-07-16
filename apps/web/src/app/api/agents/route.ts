import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { AGENT_LIST } from "@openlive/shared";
import { widenedPath } from "@openlive/shared/node";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Transparency for the Agents panel: is each agent's CLI installed, and where does it
// keep its sessions. Session dirs are the tools' own stores (resume by reopening the
// OpenLive conversation, which replays via ACP session/load).
async function present(bin: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  try { await promisify(execFile)(finder, [bin], { env: { ...process.env, PATH: widenedPath() }, timeout: 3000 }); return true; }
  catch { return false; }
}

export async function GET() {
  const home = homedir();
  const rows = await Promise.all(AGENT_LIST.map(async (a) => ({
    id: a.id, label: a.label,
    installed: (await Promise.all(a.bins.map(present))).some(Boolean),
    sessions: a.sessionsDir, home,
  })));
  return NextResponse.json(rows);
}
