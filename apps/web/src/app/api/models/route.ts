import { NextResponse } from "next/server";
import { listProviders, getProviderApiKey, getSetting } from "@openlive/db";
import { BUILTIN_PROVIDERS, envKeyFor, fetchModels, withSettings } from "@openlive/harness";
import { classifyModelsError } from "@/lib/modelsError";

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

  const provider = withSettings(BUILTIN_PROVIDERS.find((p) => p.id === providerId)!, { ollamaBaseUrl: getSetting("ollamaBaseUrl") });
  const row = configured.find((p) => p.kind === providerId);
  const key = (row ? getProviderApiKey(row.id) : null) ?? envKeyFor(provider);

  // Success stays a bare array. A failure is { error, reason } with a real status,
  // so the pickers can say "key rejected" or "offline" instead of "add a key".
  let liveError: unknown;
  try {
    const models = await fetchModels(provider, key ?? undefined, (e) => { liveError = e; });
    const failure = liveError === undefined ? null : classifyModelsError(liveError, provider);
    // A rejected key is worth saying even when the catalog could fill the list;
    // with no key at all, a 401 is expected and the pickers already ask for one.
    // A local server's list is only guesses when it cannot be reached, so say why.
    if (failure && (failure.reason === "key_rejected" ? !!key : !models.length || provider.keyless)) return NextResponse.json(failure, { status: failure.status });
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
  } catch (e) {
    const failure = classifyModelsError(liveError ?? e, provider);
    return NextResponse.json(failure, { status: failure.status });
  }
}
