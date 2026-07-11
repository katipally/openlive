import { NextResponse } from "next/server";
import { listProviders, getProviderApiKey } from "@openlive/db";
import { BUILTIN_PROVIDERS, fetchModels } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live model list for a provider, straight from its own endpoint (enriched with
// models.dev metadata for context/cost). `?provider=<id>` selects which; falls
// back to the default/first configured provider. No hardcoded vendor list.
export async function GET(req: Request) {
  const want = new URL(req.url).searchParams.get("provider");
  const configured = listProviders();
  const providerId =
    (want && BUILTIN_PROVIDERS.some((p) => p.id === want) && want) ||
    configured.find((p) => p.isDefault)?.kind ||
    configured[0]?.kind ||
    BUILTIN_PROVIDERS[0]!.id;

  const provider = BUILTIN_PROVIDERS.find((p) => p.id === providerId)!;
  const row = configured.find((p) => p.kind === providerId);
  const key =
    (row ? getProviderApiKey(row.id) : null) ??
    provider.envKeys?.map((k) => process.env[k]?.trim()).find(Boolean);

  try {
    const models = await fetchModels(provider, key ?? undefined);
    return NextResponse.json(
      models.map((m) => ({
        id: m.id,
        display_name: m.name,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        reasoning: m.reasoning,
        vision: m.vision,
        cost: m.cost,
      })),
    );
  } catch {
    return NextResponse.json([]);
  }
}
