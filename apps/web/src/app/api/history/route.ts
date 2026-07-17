import { NextResponse } from "next/server";
import { listChats, chatMessageCounts, getSetting } from "@openlive/db";
import type { HistoryChat, HistoryWorkspace } from "@openlive/shared";
import { readExternalAgentSessions } from "./agentSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Agents toggled off in Settings disappear from History too (their sessions stay
// on disk / in the DB — un-hiding restores everything).
const isHidden = (id: string | null) => !!id && getSetting(`agentHidden:${id}`) === "1";

// History grouped workspace → chats: all agents' chats for the same project live
// together, newest first; each chat carries its agent for the row's brand mark.
// Merges OpenLive's own sessions (from our DB) with each coding agent's OWN
// external sessions read from disk (source:"external", resumable via ACP
// loadSession). Only truly empty chats (never spoken in) are hidden — folderless
// conversations show under a "No folder" workspace, always sorted last.
export function GET() {
  const byCwd = new Map<string, HistoryWorkspace>();
  const add = (cwd: string, c: HistoryChat) => {
    const ws = byCwd.get(cwd) ?? { cwd, chats: [] };
    ws.chats.push(c);
    byCwd.set(cwd, ws);
  };

  // OpenLive's own sessions (folderless ones grouped under "" → "No folder").
  const counts = chatMessageCounts();
  for (const c of listChats()) {
    if ((counts[c.id] ?? 0) === 0) continue; // hide empty (a lobby connect never spoken in)
    if (isHidden(c.agentId ?? null)) continue;
    // Carry the agent's own session id so this OpenLive chat dedups against its
    // on-disk agent session (below) — and so the UI can "continue in the CLI".
    add(c.cwd ?? "", { id: c.id, title: c.title || "Conversation", updatedAt: c.updatedAt ?? c.createdAt, agentId: c.agentId ?? null, source: "openlive", resumeSessionId: c.agentSessionId });
  }

  // Each agent's own external sessions (from disk). Hidden agents are skipped
  // entirely (no discovery work either).
  const seen = new Set([...byCwd.values()].flatMap((w) => w.chats.map((s) => s.resumeSessionId ?? s.id)));
  for (const a of readExternalAgentSessions()) {
    if (isHidden(a.agentId)) continue;
    for (const s of a.sessions) {
      if (seen.has(s.id)) continue; // already surfaced as an OpenLive resume of this session
      add(s.cwd, { id: s.id, title: s.title, updatedAt: s.updatedAt, agentId: a.agentId, source: "external", resumeSessionId: s.id });
    }
  }

  const recent = (ws: HistoryWorkspace) => ws.chats.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), "");
  const workspaces: HistoryWorkspace[] = [...byCwd.values()]
    .map((ws) => ({ ...ws, chats: ws.chats.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1)) }))
    // Most-recent workspace first; the folderless bucket always last.
    .sort((x, y) => (x.cwd === "" ? 1 : y.cwd === "" ? -1 : recent(x) < recent(y) ? 1 : -1));

  return NextResponse.json(workspaces);
}
