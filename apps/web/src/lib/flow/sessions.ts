"use client";

import { useQuery } from "@tanstack/react-query";

// Flow's history, as the window reads it. The store's listing is already bounded
// by design, so nothing here asks for "everything": a page is a page, and search
// is the store's own capped scan.

export interface FlowSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  state: "active" | "archived" | "crash";
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
  if (!r.ok) throw new Error(r.status === 404 ? "That session is gone." : "Flow's history could not be read.");
  return r.json() as Promise<T>;
};

/** `pollMs` is for the one screen that waits for a turn to happen: the first
 *  run's "hold the key and say something" cannot see the trigger, because the
 *  effect only ever reaches the owner renderer, so it watches the store instead. */
export function useFlowSessions(query: string, limit = 40, pollMs = 0) {
  return useQuery({
    queryKey: ["flow-sessions", query, limit],
    queryFn: () => json<{ sessions: FlowSessionSummary[] }>(`/api/flow/sessions?limit=${limit}&q=${encodeURIComponent(query)}`),
    // A stale list is better than an empty one while the next page arrives.
    placeholderData: (prev) => prev,
    refetchInterval: pollMs || false,
  });
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

export const deleteFlowSession = (id: string) =>
  fetch(`/api/flow/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.ok);

/** The one line a row leads with: what the person actually said. */
export const sessionLine = (s: FlowSessionSummary): string => s.title || "Flow session";
