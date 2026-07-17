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

/** `<bin> --version` → a short version string, or undefined. Best-effort: some
 *  CLIs print banners — keep just the first line, capped. */
async function binVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(bin, ["--version"], { env: { ...process.env, PATH: widenedPath() }, timeout: 4000 });
    const line = stdout.trim().split("\n")[0]?.trim();
    return line ? line.slice(0, 48) : undefined;
  } catch { return undefined; }
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
    // Installed = runner binary on PATH, AND (where the binary alone proves
    // nothing) the agent's own footprint exists.
    const presentBins = await Promise.all(a.bins.map(async (b) => ((await present(b)) ? b : null)));
    const firstBin = presentBins.find(Boolean) ?? null;
    const installed = !!firstBin && (!a.installedProbe || (await evalCredProbe(a.installedProbe)) === "ready");
    // Only probe credentials when actually installed — a leftover config file
    // from an old install shouldn't render as signed in.
    const credState: CredState = installed ? await evalCredProbe(a.credProbe) : "unknown";
    // CLI version, shown in the row.
    const version = installed && firstBin ? await binVersion(firstBin) : undefined;
    return {
      id: a.id, label: a.label,
      installed,
      credState,
      version,
      authDetail: credState === "ready" ? authDetail(a.id) : undefined,
      // Wizard-style agents (hermes): sign-in IS the setup flow, so the UI says
      // "Setup incomplete"/"Finish setup" instead of "Sign in needed"/"Sign in".
      wizard: !!a.wizard,
      // The raw sign-in command, for the Copy button — the manual path when
      // opening a terminal automatically is blocked (macOS Automation).
      loginCommand: (process.platform === "win32" && a.winLogin) || a.login,
      canInstall: !!a.install,
      canUninstall: !!a.uninstall,
      canLogout: !!a.logout,
      // Update = rerun the headless install recipe with @latest. Not offered for
      // interactive installs, nor version-pinned ones (hermes) where it would just
      // reinstall the same pin.
      canUpdate: installed && !!a.install && !a.install.terminal && !a.install.pinned,
      hidden: getSetting(`agentHidden:${a.id}`) === "1",
      sessions: a.sessionsDir, home,
    };
  }));
  return NextResponse.json(rows);
}
