import { NextResponse } from "next/server";
import { listMessages, deleteChat, renameChat } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One conversation's messages (to preload the transcript when resuming).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(listMessages(id));
}

// Rename an OpenLive conversation (History → session → Rename).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  const t = title?.trim();
  if (!t) return NextResponse.json({ error: "Title required." }, { status: 400 });
  renameChat(id, t);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteChat(id);
  return NextResponse.json({ ok: true });
}
