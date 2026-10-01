"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Blocks, Folder, Globe, Monitor, Search, Sparkles, SquareTerminal, Type, Undo2, Zap, type LucideIcon } from "lucide-react";
import type { CapabilitiesWire, ToolGroupWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { asksFirst, chipOverflow, filterGroups } from "@/lib/capabilities";
import { Chip, Input, Switch, Tooltip } from "@/components/ui";
import { BuiltInBadge, NoMatch, OneLine, QueryState, card, grid2, msg, tile } from "./common";

export const capabilitiesQuery = { queryKey: ["capabilities"], queryFn: api.capabilities };

// The agent names an icon; one it does not know yet still draws.
const ICONS: Record<string, LucideIcon> = { monitor: Monitor, folder: Folder, globe: Globe, type: Type, sparkles: Sparkles, terminal: SquareTerminal, bell: Bell, search: Search, undo: Undo2 };
// Chips a card shows before "+N": about two short lines at the card's narrowest.
const CHIPS = 4;

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

/** OpenLive's own tools, in the groups they switch in. */
export function ToolsSettings() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...capabilitiesQuery, retry: 1, refetchOnWindowFocus: true });
  const flip = useFlipGroup();
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
        <div id="set-capabilities-on-demand" className={cn(card, "flex-row items-center gap-3 p-card-x")}>
          <span className={tile}><Zap aria-hidden /></span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium text-foreground">Load connector tools on demand</span>
            <OneLine text="Keeps prompts small when many connectors are on" className="text-label text-muted-foreground" />
          </span>
          {data.onDemand.available ? <Chip dot="accent">Auto</Chip> : <Chip>Coming soon</Chip>}
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
        <Tooltip label="Applies from the next call or Flow run">
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
              <Chip className="font-mono">{t.name}</Chip>
            </span>
          </Tooltip>
        ))}
        {(more > 0 || all) && g.tools.length > CHIPS && (
          <button type="button" onClick={() => setAll(!all)} aria-expanded={all} aria-label={all ? `Show fewer ${g.name} tools` : `Show ${more} more ${g.name} tools`} className="rounded-full">
            <Chip>{all ? "Fewer" : `+${more}`}</Chip>
          </button>
        )}
      </div>
      {(asks > 0 || g.needs) && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          {asks > 0 && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-arc" />{asks} ask first</span>}
          {g.needs && <span>{g.needs}</span>}
        </span>
      )}
    </div>
  );
}
