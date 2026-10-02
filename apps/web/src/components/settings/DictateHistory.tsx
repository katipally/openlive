"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CornerDownLeft, Search, Trash2 } from "lucide-react";
import type { DictateKeep, Dictation, FlowConfig } from "@openlive/flow-store";
import { Button, Chip, ConfirmButton, Input, ListGroup, Select, Tooltip } from "@/components/ui";
import { flowBridge, valueOr } from "@/lib/flow/bridge";
import { toast } from "@/lib/toast";
import { Section } from "./Section";
import { EmptyState, NoMatch, QueryState } from "./common";

type Reply = { items: Dictation[] };

const read = async (): Promise<Reply> => {
  const r = await fetch("/api/dictate/history", { cache: "no-store" });
  if (!r.ok) throw new Error("Dictate's history could not be read.");
  return r.json() as Promise<Reply>;
};
/** Shared with the subtab's count. */
export const historyQuery = { queryKey: ["dictate-history"], queryFn: read };

const KEEPS: { id: DictateKeep; label: string }[] = [
  { id: "off", label: "Keep nothing" }, { id: "day", label: "Keep 1 day" }, { id: "week", label: "Keep 7 days" },
  { id: "month", label: "Keep 30 days" }, { id: "forever", label: "Keep forever" },
];
const SEARCH_AT = 8;
// The window it went to gets a moment to come forward before the text follows.
const FOCUS_MS = 250;

const dayOf = (at: number) => {
  const d = new Date(at), today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};
const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Dictate's History: every dictation kept on this machine, for as long as `keep` says. */
export function DictateHistory({ own, insertion, save }: { own: FlowConfig["dictate"]; insertion: FlowConfig["insertion"]; save: (patch: Partial<FlowConfig["dictate"]>) => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...historyQuery, retry: 1, refetchOnWindowFocus: true });
  const [filter, setFilter] = useState("");
  const items = data?.items ?? [];
  const q = filter.trim().toLowerCase();
  // One pass to filter and group, newest day first as the list already is.
  const days = useMemo(() => {
    const out: [string, Dictation[]][] = [];
    for (const d of items) {
      if (q && !`${d.final} ${d.app ?? ""}`.toLowerCase().includes(q)) continue;
      const day = dayOf(d.at);
      if (out.at(-1)?.[0] === day) out.at(-1)![1].push(d);
      else out.push([day, [d]]);
    }
    return out;
  }, [items, q]);

  const drop = async (id?: string) => {
    const r = await fetch(`/api/dictate/history${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" });
    if (r.ok) qc.setQueryData(historyQuery.queryKey, await r.json());
    else toast("That could not be deleted.");
  };
  const keep = async (k: DictateKeep) => { save({ history: k }); await qc.invalidateQueries({ queryKey: historyQuery.queryKey }); };

  const head = (
    <span className="flex flex-wrap items-center gap-1.5">
      <Select value={own.history} onChange={(e) => void keep(e.target.value as DictateKeep)} aria-label="How long to keep dictations">
        {KEEPS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
      </Select>
      {items.length > 0 && <ConfirmButton label="Clear all" confirm={`Delete all ${items.length}`} onConfirm={() => drop()} />}
    </span>
  );
  return (
    <Section id="set-dictate-history-list" title="History" action={head}
      desc={own.history === "off" ? "Nothing is kept." : `Stays on this machine.${items.length ? ` ${items.length} ${items.length === 1 ? "dictation" : "dictations"}.` : ""}`}>
      <div className="flex flex-col gap-3">
        <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} />
        {items.length > SEARCH_AT && (
          <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search history" aria-label="Search history" />
        )}
        {data && !items.length && (
          <EmptyState>{own.history === "off" ? "History is off, so dictations are not kept." : "Nothing here yet. Your dictations show up here, kept on this machine."}</EmptyState>
        )}
        {q && items.length > 0 && !days.length && <NoMatch what="dictation" query={filter} />}
        {days.map(([day, list]) => (
          <div key={day} className="flex flex-col gap-1">
            <h3 className="text-caption font-medium text-muted-strong">{day}</h3>
            <ListGroup>{list.map((d) => <Row key={d.id} d={d} insertion={insertion} onDelete={() => void drop(d.id)} />)}</ListGroup>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Row({ d, insertion, onDelete }: { d: Dictation; insertion: FlowConfig["insertion"]; onDelete: () => void }) {
  const copy = () => void navigator.clipboard.writeText(d.final).then(() => toast("Copied", "info")).catch(() => toast("That could not be copied."));
  // Back to the window it was said into, while that window is still open; else on the clipboard to paste.
  const again = async () => {
    const api = flowBridge();
    if (api && d.windowId != null && (await api.device("control", { kind: "window", op: "activate", windowId: d.windowId })).ok) {
      await new Promise((r) => setTimeout(r, FOCUS_MS));
      const session = valueOr(await api.insertBegin(insertion.method, insertion), -1);
      if (session >= 0 && (await api.insertPush(session, d.final)).ok && (await api.insertEnd(session)).ok) return;
    }
    await navigator.clipboard.writeText(d.final).catch(() => {});
    toast("That window is gone, so it is on the clipboard. Paste it where you want it.", "info");
  };
  return (
    <div className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="line-clamp-3 whitespace-pre-line break-words text-body text-foreground">{d.final}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span>{timeOf(d.at)}</span>
          {d.app && <span className="break-words">{d.app}</span>}
          {d.command ? <Chip>Command</Chip> : <span>{countWords(d.final)} {countWords(d.final) === 1 ? "word" : "words"}</span>}
          {d.copied && <span>Copied, nowhere to type</span>}
        </span>
      </span>
      <span className="flex">
        <Tooltip label="Copy"><Button variant="ghost" size="sm" icon onClick={copy} aria-label="Copy"><Copy /></Button></Tooltip>
        {flowBridge() && <Tooltip label="Insert again"><Button variant="ghost" size="sm" icon onClick={() => void again()} aria-label="Insert again"><CornerDownLeft /></Button></Tooltip>}
        <Tooltip label="Delete"><Button variant="ghost" size="sm" icon onClick={onDelete} aria-label="Delete"><Trash2 /></Button></Tooltip>
      </span>
    </div>
  );
}
