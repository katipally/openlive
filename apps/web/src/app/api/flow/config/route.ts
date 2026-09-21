import { NextResponse } from "next/server";
import { readFlowConfig, updateFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { listProviders } from "@openlive/db";
import { BUILTIN_PROVIDERS } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flow's settings, plus the one thing the pill cannot work out for itself:
// whether there is a brain to think with.

function brainReady(config: FlowConfig): boolean {
  const rows = listProviders();
  const chosen = config.brain.providerId || rows.find((r) => r.isDefault)?.kind || rows[0]?.kind || "";
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === chosen);
  return config.brain.kind === "acp"
    ? !!config.brain.agentId
    : !!provider && (provider.keyless || rows.some((r) => r.kind === chosen && r.hasKey));
}

export function GET() {
  const config = readFlowConfig();
  return NextResponse.json({ config, brainReady: brainReady(config) });
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Merge a partial settings edit into the current config. Nested objects merge
 *  section by section so a screen that owns one switch never has to send, or be
 *  able to clobber, the sections it does not draw. */
function merge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const before = out[key];
    out[key] = isPlain(before) && isPlain(value) ? merge(before, value) : value;
  }
  return out;
}

/** Writes are read-modify-write under the store's cross-process lock, so the
 *  main process and the agent service cannot lose each other's edits. */
export async function PATCH(req: Request) {
  let patch: unknown;
  try { patch = await req.json(); } catch { patch = null; }
  if (!isPlain(patch)) return NextResponse.json({ error: "expected an object" }, { status: 400 });
  const config = await updateFlowConfig((cur) => merge(cur as unknown as Record<string, unknown>, patch) as unknown as FlowConfig);
  return NextResponse.json({ config, brainReady: brainReady(config) });
}
