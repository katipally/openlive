import { NextResponse } from "next/server";
import { deleteSession, loadSession } from "@openlive/flow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Flow transcript, with the names of the assets captured alongside it. The
// bytes are fetched separately, per asset, so opening a long session never
// carries every screenshot it took through JSON.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = loadSession(id);
  if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });
  return NextResponse.json({
    header: session.header,
    entries: session.entries,
    truncated: session.truncated,
    assets: session.assets.map((a) => ({ name: a.name, bytes: a.bytes })),
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ ok: deleteSession(id) });
}
