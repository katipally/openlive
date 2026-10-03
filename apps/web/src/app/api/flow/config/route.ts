import { NextResponse } from "next/server";
import { flowBrain, readFlowConfig, updateFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { getAllSettings, listProviders } from "@openlive/db";
import { envKeyFor, resolveApiMode } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flow's settings, plus what the runtime cannot work out for itself: whether
// there is a brain to think with, and which one (its kind and the provider or
// agent id, for a failure's report).

function brainOf(config: FlowConfig) {
  const settings = getAllSettings();
  const brain = flowBrain(config, settings);
  if (brain.kind === "acp") return { brainReady: !!brain.agentId, brainKind: "acp" as const, brainId: brain.agentId };
  const mode = resolveApiMode(settings, listProviders(), (p) => !!envKeyFor(p));
  return { brainReady: mode.ready, brainKind: "api" as const, brainId: mode.provider.id };
}

const failed = (e: unknown) =>
  NextResponse.json({ error: e instanceof Error ? e.message : "Flow's settings could not be read." }, { status: 500 });

export function GET() {
  try {
    const config = readFlowConfig();
    return NextResponse.json({ config, ...brainOf(config) });
  } catch (e) { return failed(e); }
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
  // `settle` decides an override a migration left undecided, and only while it
  // still is: a choice the person made in the meantime stands.
  const settle = new URL(req.url).searchParams.has("settle");
  try {
    const config = await updateFlowConfig((cur) => settle && cur.voice.turnOverride !== null ? cur
      : merge(cur as unknown as Record<string, unknown>, patch) as unknown as FlowConfig);
    return NextResponse.json({ config, ...brainOf(config) });
  } catch (e) { return failed(e); }
}
