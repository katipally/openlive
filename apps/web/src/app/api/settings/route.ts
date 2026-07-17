import { NextResponse } from "next/server";
import { getAllSettings, setSetting } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Provider + model are chosen live in Settings; nothing hardcoded. Live effort
// defaults to "auto" (lowest the model supports → smoothest voice).
const DEFAULTS = { liveEffort: "auto" };
const KEYS = ["liveModel", "liveProviderId", "liveEffort", "visionProviderId", "visionModel", "agentCwd", "customInstructions", "narrateProgress"];
// Per-agent config keys (acpCommand:<id> ACP override, agentHidden:<id>
// visibility toggle) are also readable/writable.
const PREFIXES = ["acpCommand:", "agentHidden:"];

const isExposed = (k: string) => KEYS.includes(k) || PREFIXES.some((p) => k.startsWith(p));

// The store holds secrets (exa_api_key) and the agent's private memory
// (agent_notes) alongside UI settings. NEVER dump the whole blob to the browser —
// return only the keys the settings UI legitimately reads.
function exposedSettings() {
  const all = getAllSettings();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (isExposed(k)) out[k] = v;
  return out;
}

// An acpCommand override is spawned verbatim (services/agent/src/agents/acp-agent.ts).
// Even though the settings route is loopback-only, an in-origin prompt-injected
// HTML canvas could PUT here — so constrain the value to a plain argv with no shell
// metacharacters, so it can never become `bash -c …` / `curl … | sh`. spawn() runs
// without a shell, so a value that survives this can only launch a named program
// with named args (npx/uvx/agent/opencode + package/version tokens).
function isSafeAcpCommand(v: string): boolean {
  if (v.length > 512) return false;
  const tokens = v.trim().split(/\s+/);
  if (!tokens.length || !tokens[0]) return false;
  // Each token: program name, package spec, flag, version, or path — no shell
  // metacharacters, quotes, whitespace-in-arg, or control chars.
  return tokens.every((t) => /^[A-Za-z0-9@._:/+=\[\]~-]+$/.test(t));
}

export function GET() {
  return NextResponse.json({ ...DEFAULTS, ...exposedSettings() });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== "string" || !isExposed(k)) continue;
    if (k.startsWith("acpCommand:") && v.trim() && !isSafeAcpCommand(v)) {
      return NextResponse.json({ error: `Rejected unsafe command for ${k}` }, { status: 400 });
    }
    await setSetting(k, v);
  }
  return NextResponse.json({ ...DEFAULTS, ...exposedSettings() });
}
