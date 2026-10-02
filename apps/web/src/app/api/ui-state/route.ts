import { NextResponse } from "next/server";
import { patchUiState, readUiState, UI_PATCH_LIMIT, validUiPatch } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What the app remembers between launches (packages/db/src/ui-state.ts). The
// page gets it in its first HTML (app/layout.tsx); this is how it saves.

export function GET() {
  return NextResponse.json(readUiState());
}

export async function PATCH(req: Request) {
  const text = await req.text();
  if (text.length > UI_PATCH_LIMIT) return NextResponse.json({ error: "Too big to save." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const patch = validUiPatch(body);
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });
  try {
    await patchUiState(patch);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
