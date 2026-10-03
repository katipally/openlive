import { NextResponse } from "next/server";
import { listChats, chatMessageCounts, deleteChatsBefore, getSetting } from "@openlive/db";
import { historyKeep, KEEP_MS } from "@openlive/flow-store";
import { AGENT_LIST, type HistoryChat, type HistoryWorkspace } from "@openlive/shared";
import { mergeListed, readExternalAgentSessions, readListedAgentSessions } from "./agentSessions";

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
// OpenLive's own chats are pruned to what Settings > Chat keeps on every read,
// as Dictate's history is. `?open=` is the conversation on screen, never pruned.
const openOf = (req: Request) => new URL(req.url).searchParams.get("open") ?? "";

export async function GET(req: Request) {
  const keep = historyKeep(getSetting("chatHistory"));
  if (keep !== "forever") await deleteChatsBefore(new Date(Date.now() - KEEP_MS[keep]).toISOString(), openOf(req));
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
    add(c.cwd ?? "", { id: c.id, title: c.title || "Conversation", updatedAt: c.updatedAt ?? c.createdAt, createdAt: c.createdAt, agentId: c.agentId ?? null, source: "openlive", resumeSessionId: c.agentSessionId });
  }

  // Each agent's own external sessions: from disk, overlaid with the agent's own
  // ACP session/list where it has one. Hidden agents are skipped entirely (no
  // discovery work either).
  const seen = new Set([...byCwd.values()].flatMap((w) => w.chats.map((s) => s.resumeSessionId ?? s.id)));
  const shown = AGENT_LIST.filter((a) => !isHidden(a.id));
  const disk = new Map(readExternalAgentSessions().map((a) => [a.agentId, a.sessions]));
  const listed = new Map((await readListedAgentSessions(shown.map((a) => a.id))).map((a) => [a.agentId, a.sessions]));
  for (const a of shown) {
    const l = listed.get(a.id);
    const sessions = l ? mergeListed(disk.get(a.id) ?? [], l, `${a.label} session`) : disk.get(a.id) ?? [];
    for (const s of sessions) {
      if (seen.has(s.id)) continue; // already surfaced as an OpenLive resume of this session
      add(s.cwd, { id: s.id, title: s.title, updatedAt: s.updatedAt, agentId: a.id, source: "external", resumeSessionId: s.id });
    }
  }

  const recent = (ws: HistoryWorkspace) => ws.chats.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), "");
  const workspaces: HistoryWorkspace[] = [...byCwd.values()]
    .map((ws) => ({ ...ws, chats: ws.chats.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1)) }))
    // Most-recent workspace first; the folderless bucket always last.
    .sort((x, y) => (x.cwd === "" ? 1 : y.cwd === "" ? -1 : recent(x) < recent(y) ? 1 : -1));

  return NextResponse.json(workspaces);
}

/** Clear all: every OpenLive chat but the open one. Agents' own CLI sessions stay. */
export async function DELETE(req: Request) {
  return NextResponse.json({ deleted: await deleteChatsBefore(new Date(Date.now() + 1000).toISOString(), openOf(req)) });
}
