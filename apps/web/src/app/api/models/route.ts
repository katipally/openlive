import { NextResponse } from "next/server";
import { BUILTIN_PROVIDERS, fetchModels } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live model list for a provider, fetched server-side (so every provider works —
// no browser CORS). `?provider=<id>`; the key rides in the `x-provider-key`
// header (the client holds it in localStorage). Without a key we still return the
// models.dev catalog so the picker isn't empty.
export async function GET(req: Request) {
  const want = new URL(req.url).searchParams.get("provider");
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === want) ?? BUILTIN_PROVIDERS[0]!;
  const key = req.headers.get("x-provider-key")?.trim()
    || provider.envKeys?.map((k) => process.env[k]?.trim()).find(Boolean)
    || undefined;

  try {
    const models = await fetchModels(provider, key);
    return NextResponse.json(
      models.map((m) => ({
        id: m.id,
        display_name: m.name,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        reasoning: m.reasoning,
        cost: m.cost,
      })),
    );
  } catch {
    return NextResponse.json([]);
  }
}
