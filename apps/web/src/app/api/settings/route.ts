import { NextResponse } from "next/server";
import { getAllSettings, setSetting } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Provider + model are chosen live in Settings; nothing hardcoded. Live effort
// defaults to "auto" (lowest the model supports → smoothest voice).
const DEFAULTS = { liveEffort: "auto" };
const KEYS = ["liveModel", "liveProviderId", "liveEffort", "visionProviderId", "visionModel"];

export function GET() {
  return NextResponse.json({ ...DEFAULTS, ...getAllSettings() });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Record<string, string>;
  for (const [k, v] of Object.entries(body)) {
    if (KEYS.includes(k) && typeof v === "string") setSetting(k, v);
  }
  return NextResponse.json({ ...DEFAULTS, ...getAllSettings() });
}
