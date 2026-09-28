import { AGENT_REGISTRY, isAgentId, type HistoryChat, type HistoryWorkspace } from "@openlive/shared";

// The session drawer's list: every workspace's chats as one newest-first list,
// grouped by how long ago, each row saying when and for how long. `now` is a
// parameter so the wording is testable and one render reads one clock.

export interface HistoryRow { chat: HistoryChat; cwd: string }

const DAY_MS = 86_400_000;

/** Whole calendar days between the local midnight before `t` and today's. */
function daysAgo(t: Date, now: Date): number {
  const a = new Date(t); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** "Today", "Yesterday", "Earlier this week", "Last 30 days", then the month. */
export function historyGroup(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "Earlier";
  const days = daysAgo(t, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 30) return "Last 30 days";
  return t.toLocaleDateString(undefined, { month: "long", ...(t.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** "just now", "12m ago", "2h ago", "Yesterday", "Tue", then the date. */
export function relativeTime(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const s = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
  const days = daysAgo(t, now);
  if (days <= 0) return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return t.toLocaleDateString(undefined, { weekday: "short" });
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(t.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** How long a conversation ran, "18 min" or "1 h 4 min". Empty when unknown,
 *  and past a day, where the span says more about a later resume than the talk. */
export function spanLabel(from: string | undefined, to: string): string {
  if (!from) return "";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0 || ms >= DAY_MS) return "";
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}

/** Every workspace's chats as one list, newest first, each id once. O(n log n). */
export function flattenHistory(workspaces: HistoryWorkspace[]): HistoryRow[] {
  const byId = new Map<string, HistoryRow>();
  for (const ws of workspaces) for (const chat of ws.chats) if (!byId.has(chat.id)) byId.set(chat.id, { chat, cwd: ws.cwd });
  return [...byId.values()].sort((a, b) => (a.chat.updatedAt < b.chat.updatedAt ? 1 : a.chat.updatedAt > b.chat.updatedAt ? -1 : 0));
}

/** Consecutive rows under one heading. Input is already newest first. O(n). */
export function groupHistory(rows: HistoryRow[], now = new Date()): { label: string; rows: HistoryRow[] }[] {
  const out: { label: string; rows: HistoryRow[] }[] = [];
  for (const r of rows) {
    const label = historyGroup(r.chat.updatedAt, now);
    const last = out[out.length - 1];
    if (last?.label === label) last.rows.push(r);
    else out.push({ label, rows: [r] });
  }
  return out;
}

// External sessions we can delete are plain files/dirs; opencode/hermes keep theirs
// inside live sqlite databases we won't write into, so those have no delete.
export const canDelete = (c: HistoryChat) =>
  c.source !== "external" || (!!c.agentId && isAgentId(c.agentId) && AGENT_REGISTRY[c.agentId].externalDeletable);

/** The deletable chats of each folder, keyed by cwd, for "Delete all from <folder>".
 *  Chats without a folder are left out. O(n). */
export function folderSessions(rows: HistoryRow[]): Map<string, HistoryChat[]> {
  const out = new Map<string, HistoryChat[]>();
  for (const { chat, cwd } of rows) {
    if (!cwd || !canDelete(chat)) continue;
    const list = out.get(cwd);
    if (list) list.push(chat); else out.set(cwd, [chat]);
  }
  return out;
}
