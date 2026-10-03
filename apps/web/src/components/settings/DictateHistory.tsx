"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DictateKeep, Dictation, FlowConfig } from "@openlive/flow-store";
import { ConfirmButton, ListGroup, ListRow, Select } from "@/components/ui";
import { useUi } from "@/lib/uiStore";
import { toast } from "@/lib/toast";
import { LinkRow } from "./nav";
import { Section } from "./Section";

type Reply = { items: Dictation[] };

const read = async (): Promise<Reply> => {
  const r = await fetch("/api/dictate/history", { cache: "no-store" });
  if (!r.ok) throw new Error("Dictate's history could not be read.");
  return r.json() as Promise<Reply>;
};
/** Shared by Dictate's home, which lists them, and Settings, which keeps them. */
export const historyQuery = { queryKey: ["dictate-history"], queryFn: read };

/** Deletes one dictation, or every one without `id`. The reply is the list as kept after. */
export async function dropDictations(qc: QueryClient, id?: string): Promise<void> {
  const r = await fetch(`/api/dictate/history${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" });
  if (r.ok) qc.setQueryData(historyQuery.queryKey, await r.json());
  else toast("That could not be deleted.");
}

const KEEPS: { id: DictateKeep; label: string }[] = [
  { id: "off", label: "Keep nothing" }, { id: "day", label: "Keep 1 day" }, { id: "week", label: "Keep 7 days" },
  { id: "month", label: "Keep 30 days" }, { id: "forever", label: "Keep forever" },
];

/** How long dictations stay on this machine, and Clear all. The list is on Dictate's home. */
export function DictateHistory({ own, save }: { own: FlowConfig["dictate"]; save: (patch: Partial<FlowConfig["dictate"]>) => void }) {
  const qc = useQueryClient();
  const count = useQuery({ ...historyQuery, retry: 1 }).data?.items.length ?? 0;
  const inCall = useUi((s) => s.liveOpen);
  // The list is pruned to the new length when it is next read, which has to wait for the save to land.
  const kept = useRef(own.history);
  useEffect(() => {
    if (kept.current === own.history) return;
    kept.current = own.history;
    void qc.invalidateQueries({ queryKey: historyQuery.queryKey });
  }, [own.history, qc]);

  return (
    <Section id="set-dictate-history" title="History" desc="What was dictated, kept on this machine only.">
      <ListGroup>
        <ListRow label="Keep dictations" detail={own.history === "off" ? "Nothing is kept" : count === 1 ? "1 kept now" : `${count} kept now`}>
          <Select value={own.history} onChange={(e) => save({ history: e.target.value as DictateKeep })} aria-label="How long to keep dictations">
            {KEEPS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </Select>
        </ListRow>
        {count > 0 && (
          <ListRow label="Clear all" detail="Deletes every kept dictation">
            <ConfirmButton label="Clear all" confirm={count === 1 ? "Delete it" : `Delete all ${count}`} onConfirm={() => void dropDictations(qc)} />
          </ListRow>
        )}
        {!inCall && (
          <LinkRow label="Your dictations" value="In Dictate" shared={false}
            onGo={() => { useUi.getState().closeSettings(); useUi.getState().setMode("dictate"); }} />
        )}
      </ListGroup>
    </Section>
  );
}
