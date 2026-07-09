import { NextResponse } from "next/server";
import { listMessages, deleteChat } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One conversation's messages (to preload the transcript when resuming).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(listMessages(id));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteChat(id);
  return NextResponse.json({ ok: true });
}
