import { NextResponse } from "next/server";
import { listProviders, upsertProviderByKind } from "@openlive/db";
import { BUILTIN_PROVIDERS } from "@openlive/harness";
import type { ProviderKind } from "@openlive/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Configured providers (DB rows with key status). The UI merges this with the
// full BUILTIN_PROVIDERS list to show every available provider.
export function GET() {
  return NextResponse.json(listProviders());
}

// Upsert a key for a provider by its registry id (kind). Creates the DB row on
// first use (atomically — no dup rows under concurrent first-time POSTs); the
// first provider configured becomes the default.
export async function POST(req: Request) {
  let body: { kind?: string; apiKey?: string };
  try {
    body = (await req.json()) as { kind?: string; apiKey?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { kind, apiKey } = body ?? {};
  const info = BUILTIN_PROVIDERS.find((p) => p.id === kind);
  if (!kind || !info) return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  const row = await upsertProviderByKind(kind as ProviderKind, info.name, apiKey);
  return NextResponse.json(row);
}
