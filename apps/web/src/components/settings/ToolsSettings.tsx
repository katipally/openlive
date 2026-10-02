"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Bell, Blocks, BookOpen, Folder, Globe, Monitor, Plug, Search, ShieldQuestion, Sparkles, SquareTerminal, Type, Undo2, Zap, type LucideIcon } from "lucide-react";
import { ToolGlyph } from "@/components/live/ToolGlyph";
import type { CapabilitiesWire, EditWire, OnDemandMode, ReminderWire, ToolGroupWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { asksFirst, chipOverflow, filterGroups, onDemandCaption } from "@/lib/capabilities";
import { Button, Chip, ConfirmButton, Input, Segmented, Switch, Tooltip, type SegOption } from "@/components/ui";
import { BuiltInBadge, NoMatch, OneLine, QueryState, card, grid2, msg, tile } from "./common";

export const capabilitiesQuery = { queryKey: ["capabilities"], queryFn: api.capabilities };

// The agent names an icon; one it does not know yet still draws.
const ICONS: Record<string, LucideIcon> = { monitor: Monitor, folder: Folder, globe: Globe, type: Type, sparkles: Sparkles, terminal: SquareTerminal, bell: Bell, search: Search, undo: Undo2, book: BookOpen, plug: Plug, alarm: AlarmClock };
// Chips a card shows before "+N": about two short lines at the card's narrowest.
const CHIPS = 4;
// Upcoming timers and reminders the Reminders card lists before "and N more".
const UPCOMING = 3;
const upcomingQuery = { queryKey: ["reminders"], queryFn: api.reminders };
// Recent edits the Find and undo card lists, each with Undo.
const RECENT = 3;
const editsQuery = { queryKey: ["edits"], queryFn: api.edits };

/** Turns a built-in group on or off: moves at once, and goes back if the agent says no. */
export function useFlipGroup() {
  const qc = useQueryClient();
  return (g: ToolGroupWire) => {
    const set = (enabled: boolean) => qc.setQueryData<CapabilitiesWire>(capabilitiesQuery.queryKey, (d) => d && { ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, enabled } : x)) });
    set(!g.enabled);
    api.setToolGroupEnabled(g.id, !g.enabled)
      .then((d) => qc.setQueryData(capabilitiesQuery.queryKey, d))
      .catch((e) => { set(g.enabled); toast(`Couldn’t turn ${g.name} ${g.enabled ? "off" : "on"}. ${msg(e)}`); });
  };
}

const MODES: readonly SegOption<OnDemandMode>[] = [
  { id: "auto", label: "Auto", title: "When many connector tools are on. Applies from the next call or Flow run." },
  { id: "on", label: "On", title: "Always. Applies from the next call or Flow run." },
  { id: "off", label: "Off", title: "Never. Applies from the next call or Flow run." },
];

/** Sets how connector tools load: moves at once, and goes back if the agent says no. */
function useSetOnDemand() {
  const qc = useQueryClient();
  return (from: OnDemandMode, to: OnDemandMode) => {
    const set = (mode: OnDemandMode) => qc.setQueryData<CapabilitiesWire>(capabilitiesQuery.queryKey, (d) => d && { ...d, onDemand: { ...d.onDemand, mode } });
    set(to);
    api.setOnDemandMode(to)
      .then((d) => qc.setQueryData(capabilitiesQuery.queryKey, d))
      .catch((e) => { set(from); toast(`Couldn’t change how connector tools load. ${msg(e)}`); });
  };
}

/** OpenLive's own tools, in the groups they switch in. */
export function ToolsSettings() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...capabilitiesQuery, retry: 1, refetchOnWindowFocus: true });
  const flip = useFlipGroup();
  const setOnDemand = useSetOnDemand();
  const [filter, setFilter] = useState("");
  const shown = filterGroups(data?.groups ?? [], filter);

  return (
    <div id="set-capabilities-tools-list" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Input type="search" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tool" aria-label="Find a tool" className="min-w-0 flex-1 basis-48" />
        <span className="text-caption text-muted-foreground">All built in. Turn off what you never need.</span>
      </div>
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} />
      {filter.trim() && data && shown.length === 0 && <NoMatch what="tool" query={filter} />}
      {shown.length > 0 && (
        <div className={grid2}>
          {shown.map((g) => <GroupCard key={g.id} g={g} onFlip={() => flip(g)} />)}
        </div>
      )}
      {data && (
        <div id="set-capabilities-on-demand" className={cn(card, "flex-row flex-wrap items-center gap-3 p-card-x")}>
          <span className={tile}><Zap aria-hidden /></span>
          <span className="flex min-w-0 flex-1 basis-48 flex-col">
            <span className="text-body font-medium text-foreground">Load connector tools on demand</span>
            <OneLine text={data.onDemand.available ? onDemandCaption(data.onDemand) : "Keeps prompts small when many connectors are on"} className="text-label text-muted-foreground" />
          </span>
          {data.onDemand.available ? (
            <Segmented label="Load connector tools on demand" size="sm" options={MODES} value={data.onDemand.mode}
              onChange={(m) => { if (m !== data.onDemand.mode) setOnDemand(data.onDemand.mode, m); }} />
          ) : <Chip>Coming soon</Chip>}
        </div>
      )}
    </div>
  );
}

function GroupCard({ g, onFlip }: { g: ToolGroupWire; onFlip: () => void }) {
  const [all, setAll] = useState(false);
  const Icon = ICONS[g.icon] ?? Blocks;
  const { shown, more } = chipOverflow(g.tools, all ? g.tools.length : CHIPS);
  const asks = asksFirst(g);
  return (
    <div className={cn(card, "gap-3 p-card-x")}>
      <div className="flex items-start gap-3">
        <span className={cn(tile, !g.enabled && "opacity-60")}><Icon aria-hidden /></span>
        <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !g.enabled && "opacity-60")}>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words text-body font-semibold text-foreground">{g.name}</span>
            <BuiltInBadge />
          </span>
          <OneLine text={g.description} className="text-label text-muted-foreground" />
        </div>
        <Tooltip label="Switches OpenLive's own tools only: a coding agent keeps its built-in ones. Applies from the next call or Flow run.">
          <label className="flex cursor-pointer items-center">
            <span className="sr-only">Use {g.name}</span>
            <Switch on={g.enabled} onFlip={onFlip} />
          </label>
        </Tooltip>
      </div>
      <div className={cn("flex flex-wrap gap-1.5", !g.enabled && "opacity-60")}>
        {shown.map((t) => (
          <Tooltip key={t.name} label={t.asksFirst ? `${t.description} Asks first.` : t.description}>
            <span tabIndex={0} className="rounded-full">
              <Chip className="font-mono"><ToolGlyph tool={t.name} className="text-current" />{t.name}{t.asksFirst && <ShieldQuestion aria-label="Asks first" />}</Chip>
            </span>
          </Tooltip>
        ))}
        {(more > 0 || all) && g.tools.length > CHIPS && (
          <button type="button" onClick={() => setAll(!all)} aria-expanded={all} aria-label={all ? `Show fewer ${g.name} tools` : `Show ${more} more ${g.name} tools`} className="rounded-full">
            <Chip>{all ? "Fewer" : `+${more}`}</Chip>
          </button>
        )}
      </div>
      {g.id === "reminders" && g.enabled && <Upcoming />}
      {g.id === "find" && <RecentEdits />}
      {(asks > 0 || g.needs) && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          {asks > 0 && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-arc" />{asks} ask first</span>}
          {g.needs && <span>{g.needs}</span>}
        </span>
      )}
    </div>
  );
}

/** "Thu 6:00 PM", in the viewer's own locale and zone, and how it repeats. */
const when = (r: ReminderWire) =>
  `${new Date(r.dueAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}${r.repeat === "none" ? "" : `, ${r.repeat}`}`;

/** The next few timers and reminders, each with Cancel. Refetched every minute, as they go off on their own. */
function Upcoming() {
  const qc = useQueryClient();
  const { data } = useQuery({ ...upcomingQuery, refetchInterval: 60_000, refetchOnWindowFocus: true });
  if (!data) return null;
  const cancel = (r: ReminderWire) => api.cancelReminder(r.id)
    .then((d) => qc.setQueryData(upcomingQuery.queryKey, d))
    .catch((e) => toast(`Couldn’t cancel that. ${msg(e)}`));
  const more = data.items.length - UPCOMING;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
      <span className="text-caption text-muted-foreground">Upcoming</span>
      {data.items.length === 0 && <span className="text-label text-faint">Nothing yet. Ask in a call or in Flow, like “remind me at 6 to call the bank”.</span>}
      {data.items.slice(0, UPCOMING).map((r) => (
        <div key={r.id} className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <OneLine text={r.text || "Timer"} className="text-label text-foreground" />
            <span className="text-caption text-muted-foreground">{r.kind === "timer" ? "Timer, " : ""}{when(r)}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => void cancel(r)} aria-label={`Cancel ${r.text || "the timer"}`}>Cancel</Button>
        </div>
      ))}
      {more > 0 && <span className="text-caption text-faint">and {more} more</span>}
    </div>
  );
}

const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

/** The last few edits OpenLive's file tools made, kept even with the group off, each with Undo. */
function RecentEdits() {
  const qc = useQueryClient();
  const { data } = useQuery({ ...editsQuery, refetchOnWindowFocus: true });
  if (!data) return null;
  const undo = (e: EditWire) => api.undoEdit(e.id)
    .then((d) => { qc.setQueryData(editsQuery.queryKey, d); toast(`Undid the change to ${e.path}.`); })
    .catch((err) => toast(`Couldn’t undo that. ${msg(err)}`));
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
      <span className="text-caption text-muted-foreground">Recent edits</span>
      {data.items.length === 0 && <span className="text-label text-faint">None yet. Changes OpenLive makes to your workspace files show here, ready to undo.</span>}
      {data.items.slice(0, RECENT).map((e) => (
        <div key={e.id} className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <OneLine text={e.path} className="text-label text-foreground" />
            <OneLine text={`${folderOf(e.root)}, ${new Date(e.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}, ${e.tool === "undo_edit" ? "an undo, " : ""}${e.summary}`} className="text-caption text-muted-foreground" />
          </span>
          <ConfirmButton label="Undo" confirm="Undo it?" onConfirm={() => undo(e)} />
        </div>
      ))}
    </div>
  );
}
