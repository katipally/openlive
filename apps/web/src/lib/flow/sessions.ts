"use client";

import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import { deferDelete } from "@/lib/deferredDelete";

// Flow's history, as the window reads it. The store's listing is already bounded
// by design, so nothing here asks for "everything": a page is a page, and search
// is the store's own capped scan.

export interface FlowSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  state: "active" | "archived" | "crash";
  /** Pictures kept beside this session. */
  assets: number;
}

export interface FlowSessionEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface FlowSessionDetail {
  header: ({ id: string; createdAt: string } & Record<string, unknown>) | null;
  entries: FlowSessionEntry[];
  truncated: boolean;
  assets: { name: string; bytes: number }[];
}

const json = async <T>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 404 ? "That session is gone." : "Couldn't read Flow's history.");
  return r.json() as Promise<T>;
};

/** Pages by offset, so "see more" reads only the new page. A short page is the
 *  last one. `first` is how many show before anyone asks for more. */
export function useFlowSessionPages(query: string, first: number, page: number) {
  return useInfiniteQuery({
    queryKey: ["flow-sessions", "pages", query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => json<{ sessions: FlowSessionSummary[] }>(
      `/api/flow/sessions?limit=${pageParam ? page : first}&offset=${pageParam}&q=${encodeURIComponent(query)}`,
    ).then((r) => r.sessions),
    getNextPageParam: (last, pages, offset) => (last.length < (offset ? page : first) ? undefined : offset + last.length),
    placeholderData: (prev) => prev,
  });
}

/** How many sessions are kept, for Settings > Flow's History. */
export const useFlowSessionCount = () => useQuery({
  queryKey: ["flow-sessions", "total"],
  queryFn: () => json<{ total?: number }>("/api/flow/sessions?limit=1").then((r) => r.total ?? 0),
});

/** Clear all: every session but a running one. False when that failed. */
export async function clearFlowSessions(qc: QueryClient): Promise<boolean> {
  const ok = await fetch("/api/flow/sessions", { method: "DELETE" }).then((r) => r.ok, () => false);
  await refreshFlowSessions(qc);
  return ok;
}

export function useFlowSession(id: string | null) {
  return useQuery({
    queryKey: ["flow-session", id],
    queryFn: () => json<FlowSessionDetail>(`/api/flow/sessions/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

export const assetUrl = (sessionId: string, name: string) =>
  `/api/flow/sessions/${encodeURIComponent(sessionId)}/asset?name=${encodeURIComponent(name)}`;

// keepalive, so a delete committed as the window closes still reaches the server.
// Offline is a failed delete, reported by the caller, not a rejection nobody catches.
export const deleteFlowSession = (id: string) =>
  fetch(`/api/flow/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).then((r) => r.ok, () => false);

/** Session keys in the shared pending-delete store; lists filter on it. */
export const pendingSessionKey = (id: string) => `flow:${id}`;

/** Hides the sessions now and deletes them once the undo toast is gone. */
export function deleteWithUndo(ids: string[], qc: QueryClient) {
  if (!ids.length) return;
  deferDelete(ids.map(pendingSessionKey), ids.length === 1 ? "Session deleted" : `${ids.length} sessions deleted`, async () => {
    const ok = await Promise.all(ids.map(deleteFlowSession));
    await refreshFlowSessions(qc);
    return !ok.includes(false);
  }, ids.length === 1 ? "Couldn't delete that session. It's back in the list." : "Some couldn't be deleted. They're back in the list.");
}

export const renameFlowSession = (id: string, title: string) =>
  fetch(`/api/flow/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
  }).then(async (r) => r.ok && (await r.json()).ok === true);

/** After a rename or delete: the list pages, and the one open transcript. */
export const refreshFlowSessions = (qc: QueryClient) => Promise.all([
  qc.invalidateQueries({ queryKey: ["flow-sessions"] }),
  qc.invalidateQueries({ queryKey: ["flow-session"] }),
]);

/** The one line a row leads with: what the person actually said. */
export const sessionLine = (s: FlowSessionSummary): string => s.title || "Flow session";
