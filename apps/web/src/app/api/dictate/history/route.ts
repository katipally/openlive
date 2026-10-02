import { NextResponse } from "next/server";
import { addDictation, clearDictations, deleteDictation, readDictations, readFlowConfig } from "@openlive/flow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dictate's history, on this machine only: listed in Settings > Dictate, and
// added to by the owner renderer after each insertion. Every read prunes to
// what Settings says to keep, so the file stays bounded without a timer.

const keep = () => readFlowConfig().dictate.history;
const failed = (e: unknown) => NextResponse.json({ error: e instanceof Error ? e.message : "Dictate's history could not be read." }, { status: 500 });

export function GET() {
  try { return NextResponse.json({ items: readDictations(keep()), keep: keep() }); }
  catch (e) { return failed(e); }
}

export async function POST(req: Request) {
  let d: Record<string, unknown>;
  try { d = (await req.json()) as Record<string, unknown>; } catch { d = {}; }
  if (typeof d.final !== "string" || !d.final) return NextResponse.json({ error: "send { raw, cleaned, final }" }, { status: 400 });
  try {
    const k = keep();
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    addDictation({ raw: s(d.raw), cleaned: s(d.cleaned), final: d.final, app: s(d.app) || undefined, windowId: typeof d.windowId === "number" ? d.windowId : undefined, command: d.command === true, copied: d.copied === true }, k);
    // O(kept) per dictation: the read also compacts, which keeps the file under twice the cap.
    readDictations(k);
    return NextResponse.json({ ok: true });
  } catch (e) { return failed(e); }
}

/** `?id=` deletes one; no id clears them all. */
export function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  try {
    if (id) deleteDictation(id); else clearDictations();
    return NextResponse.json({ items: readDictations(keep()) });
  } catch (e) { return failed(e); }
}
