import type { QueryClient } from "@tanstack/react-query";
import type { Dictation } from "@openlive/flow-store";
import { deferDelete } from "../deferredDelete";

// Dictate's kept history as the window reads and deletes it: listed on
// Dictate's home, kept and cleared in Settings > Dictate.

type Reply = { items: Dictation[] };

const read = async (): Promise<Reply> => {
  const r = await fetch("/api/dictate/history", { cache: "no-store" });
  if (!r.ok) throw new Error("Couldn't read Dictate's history.");
  return r.json() as Promise<Reply>;
};
/** Shared by Dictate's home, which lists them, and Settings, which keeps them. */
export const historyQuery = { queryKey: ["dictate-history"], queryFn: read };

/** Deletes one dictation, or every one without `id`. The reply is the list as
 *  kept after. keepalive, so a delete committed as the window closes still lands. */
export async function dropDictations(qc: QueryClient, id?: string): Promise<boolean> {
  const r = await fetch(`/api/dictate/history${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE", keepalive: true }).catch(() => null);
  if (r?.ok) qc.setQueryData(historyQuery.queryKey, await r.json());
  return !!r?.ok;
}

/** Dictation keys in the shared pending-delete store; the home list filters on it. */
export const pendingDictationKey = (id: string) => `dictation:${id}`;

/** Hides the dictation now and deletes it once the Undo toast is gone, as Chat and Flow do. */
export const deleteDictation = (qc: QueryClient, id: string) =>
  deferDelete(pendingDictationKey(id), "Dictation deleted", () => dropDictations(qc, id), "Couldn't delete that dictation. It's back in the list.");
