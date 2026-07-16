import { NextResponse } from "next/server";
import { listProviders, createProvider, updateProvider } from "@openlive/db";
import { BUILTIN_PROVIDERS } from "@openlive/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Configured providers (DB rows with key status). The UI merges this with the
// full BUILTIN_PROVIDERS list to show every available provider.
export function GET() {
  return NextResponse.json(listProviders());
}

// Upsert a key for a provider by its registry id (kind). Creates the DB row on
// first use; the first provider configured becomes the default.
export async function POST(req: Request) {
  const { kind, apiKey } = (await req.json()) as { kind?: string; apiKey?: string };
  const info = BUILTIN_PROVIDERS.find((p) => p.id === kind);
  if (!kind || !info) return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  const existing = listProviders().find((p) => p.kind === kind);
  const row = existing
    ? await updateProvider(existing.id, { apiKey })
    : await createProvider({ name: info.name, kind, apiKey, isDefault: listProviders().length === 0 });
  return NextResponse.json(row);
}
