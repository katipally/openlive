import { NextResponse } from "next/server";
import { readFlowConfig } from "@openlive/flow-store";
import { listProviders } from "@openlive/db";
import { BUILTIN_PROVIDERS } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flow's settings, plus the one thing the pill cannot work out for itself:
// whether there is a brain to think with. Read-only — Block 6 owns the editor.
export function GET() {
  const config = readFlowConfig();
  const rows = listProviders();
  const chosen = config.brain.providerId || rows.find((r) => r.isDefault)?.kind || rows[0]?.kind || "";
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === chosen);
  const brainReady = config.brain.kind === "acp"
    ? !!config.brain.agentId
    : !!provider && (provider.keyless || rows.some((r) => r.kind === chosen && r.hasKey));
  return NextResponse.json({ config, brainReady });
}
