import { NextResponse } from "next/server";
import { deleteExternalSession } from "../agentSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Permanently delete a coding agent's OWN on-disk session (History → external
// session → Delete). Irreversible — removes it from Claude Code / Codex / Cursor,
// not just OpenLive. The UI gates this behind an explicit confirm modal.
export async function DELETE(req: Request) {
  const { agentId, id } = (await req.json().catch(() => ({}))) as { agentId?: string; id?: string };
  if (!agentId || !id) return NextResponse.json({ error: "agentId and id required." }, { status: 400 });
  const ok = deleteExternalSession(agentId, id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
