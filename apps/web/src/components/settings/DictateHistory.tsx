"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FlowConfig } from "@openlive/flow-store";
import { dropDictations, historyQuery } from "@/lib/dictate/history";
import { HistorySection } from "./HistorySection";

/** How long dictations stay on this machine, and Clear all. The list is on Dictate's home. */
export function DictateHistory({ own, save }: { own: FlowConfig["dictate"]; save: (patch: Partial<FlowConfig["dictate"]>) => void }) {
  const qc = useQueryClient();
  const count = useQuery({ ...historyQuery, retry: 1 }).data?.items.length;
  // The list is pruned to the new length when it is next read, which has to wait for the save to land.
  const kept = useRef(own.history);
  useEffect(() => {
    if (kept.current === own.history) return;
    kept.current = own.history;
    void qc.invalidateQueries({ queryKey: historyQuery.queryKey });
  }, [own.history, qc]);

  return (
    <HistorySection id="set-dictate-history" mode="dictate" noun="dictations" desc="What you dictated, kept on this machine only."
      keep={own.history} onKeep={(history) => save({ history })} count={count} offDetail="Nothing is kept"
      onClear={() => dropDictations(qc)} />
  );
}
