import { NextResponse } from "next/server";
import { listChats, chatMessageCounts, getSetting } from "@openlive/db";
import { AGENT_LIST, agentLabel } from "@openlive/shared";
import type { HistoryAgent, HistoryWorkspace, HistorySession } from "@openlive/shared";
import { readExternalAgentSessions } from "./agentSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Agent order for the History sidebar comes from the shared registry (so every
// agent — current and future — shows up automatically). null = built-in assistant.
const AGENT_ORDER: (string | null)[] = [null, ...AGENT_LIST.map((a) => a.id)];

// Agents toggled off in Settings disappear from History too (their sessions stay
// on disk / in the DB — un-hiding restores everything).
const isHidden = (id: string | null) => !!id && getSetting(`agentHidden:${id}`) === "1";

// History grouped agent → workspace → session. Merges OpenLive's own sessions
// (from our DB, filed by the agent + workspace stamped on each) with each coding
// agent's OWN external sessions read from disk (source:"external", resumable via
// ACP loadSession). Only truly empty chats (never spoken in) are hidden — folderless
// OpenLive conversations show under a "No folder" workspace so OpenLive's own history
// is always browsable here too.
export function GET() {
  // agentKey → cwd → workspace
  const byAgent = new Map<string, Map<string, HistoryWorkspace>>();
  const add = (agentKey: string, cwd: string, s: HistorySession) => {
    const wsMap = byAgent.get(agentKey) ?? new Map<string, HistoryWorkspace>();
    const ws = wsMap.get(cwd) ?? { cwd, sessions: [] };
    ws.sessions.push(s);
    wsMap.set(cwd, ws);
    byAgent.set(agentKey, wsMap);
  };

  // OpenLive's own sessions (folderless ones grouped under "" → "No folder").
  const counts = chatMessageCounts();
  for (const c of listChats()) {
    if ((counts[c.id] ?? 0) === 0) continue; // hide empty (a lobby connect never spoken in)
    // Carry the agent's own session id so this OpenLive chat dedups against its
    // on-disk agent session (below) — and so the UI can "continue in the CLI".
    add(c.agentId ?? "", c.cwd ?? "", { id: c.id, title: c.title || "Conversation", updatedAt: c.updatedAt ?? c.createdAt, source: "openlive", resumeSessionId: c.agentSessionId });
  }

  // Each agent's own external sessions (from disk). Hidden agents are skipped
  // entirely (no discovery work either).
  const seen = new Set([...byAgent.values()].flatMap((wsMap) => [...wsMap.values()].flatMap((w) => w.sessions.map((s) => s.resumeSessionId ?? s.id))));
  for (const a of readExternalAgentSessions()) {
    if (isHidden(a.agentId)) continue;
    for (const s of a.sessions) {
      if (seen.has(s.id)) continue; // already surfaced as an OpenLive resume of this session
      add(a.agentId, s.cwd, { id: s.id, title: s.title, updatedAt: s.updatedAt, source: "external", resumeSessionId: s.id });
    }
  }

  const recent = (ws: HistoryWorkspace) => ws.sessions.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), "");
  const agents: HistoryAgent[] = AGENT_ORDER
    .filter((a) => byAgent.has(a ?? "") && !isHidden(a))
    .map((a) => {
      const workspaces = [...byAgent.get(a ?? "")!.values()]
        .map((ws) => ({ ...ws, sessions: ws.sessions.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1)) }))
        .sort((x, y) => (recent(x) < recent(y) ? 1 : -1));
      return { agentId: a, label: agentLabel(a), workspaces };
    });

  return NextResponse.json(agents);
}
