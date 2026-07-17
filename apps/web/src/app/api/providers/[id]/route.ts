import { NextResponse } from "next/server";
import { updateProvider, clearProviderKey } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Update a provider's API key, or clear it. Provider-agnostic — every provider
// keys differently (sk-ant-…, sk-…, etc.), so we don't validate the prefix; a
// bad key surfaces as a clear 401 the first time it's used.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.clear) {
    const provider = await clearProviderKey(id);
    if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(provider);
  }

  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!key) return NextResponse.json({ error: "Paste an API key." }, { status: 400 });

  const provider = await updateProvider(id, { apiKey: key });
  if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(provider);
}
