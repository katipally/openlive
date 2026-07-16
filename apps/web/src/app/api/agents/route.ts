import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { AGENT_LIST } from "@openlive/shared";
import { widenedPath, evalCredProbe, readJsonHome, type CredState } from "@openlive/shared/node";
import { getSetting } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Status for the Agents panel: is each agent's CLI installed, is it signed in
// (read-only credential probe — file/JSON/keychain presence, never the secret),
// and is it hidden from selectors. Session dirs are the tools' own stores.
async function present(bin: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  try { await promisify(execFile)(finder, [bin], { env: { ...process.env, PATH: widenedPath() }, timeout: 3000 }); return true; }
  catch { return false; }
}

/** A human detail for the signed-in state where the store exposes one (cursor
 *  keeps the account email in its CLI config). */
function authDetail(id: string): string | undefined {
  if (id !== "cursor") return undefined;
  const info = readJsonHome("~/.cursor/cli-config.json")?.authInfo as { email?: string } | undefined;
  return typeof info?.email === "string" ? info.email : undefined;
}

export async function GET() {
  const home = homedir();
  const rows = await Promise.all(AGENT_LIST.map(async (a) => {
    const installed = (await Promise.all(a.bins.map(present))).some(Boolean);
    // Only probe credentials when the CLI exists — a probe hit without the CLI
    // (leftover config from an old install) shouldn't render as signed in.
    const credState: CredState = installed ? await evalCredProbe(a.credProbe) : "unknown";
    return {
      id: a.id, label: a.label,
      installed,
      credState,
      authDetail: credState === "ready" ? authDetail(a.id) : undefined,
      canLogout: !!a.logout,
      hidden: getSetting(`agentHidden:${a.id}`) === "1",
      sessions: a.sessionsDir, home,
    };
  }));
  return NextResponse.json(rows);
}
