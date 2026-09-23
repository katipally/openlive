import { NextResponse } from "next/server";
import { deleteSession, loadSession, readSessionState, renameSession, sessionPath } from "@openlive/flow-store";

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

const MAX_TITLE = 200;

/** Refuses the running session: it is still being written. */
function refused(id: string): NextResponse | null {
  const path = sessionPath(id);
  if (!path) return NextResponse.json({ error: "No such session." }, { status: 404 });
  return readSessionState(path) === "active"
    ? NextResponse.json({ error: "That session is still running." }, { status: 409 })
    : null;
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return refused(id) ?? NextResponse.json({ ok: deleteSession(id) });
}

/** `{ title }`; an empty title goes back to the first thing said. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
  if (typeof body?.title !== "string") return NextResponse.json({ error: "A title is needed." }, { status: 400 });
  return refused(id) ?? NextResponse.json({ ok: renameSession(id, body.title.slice(0, MAX_TITLE)) });
}
