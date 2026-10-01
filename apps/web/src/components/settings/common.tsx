"use client";

import type { ReactNode } from "react";
import { Loader2, Lock, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, Button, Tooltip } from "@/components/ui";

// What the Capabilities and Memory pages share: their loading, failure, empty
// and no-match states, the one-line description, and the class lists of their
// fields, panels and card grids.

/** Past this many items a list gets a filter. */
export const FILTER_AT = 8;
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A label over its field. */
export const field = "flex min-w-0 flex-col gap-1 text-label text-muted-foreground";
/** A raised panel for adding something. */
export const panel = "flex flex-col gap-3 rounded-xl bg-card p-3 shadow-card";
/** A panel inside a row or card: an editor, a review. */
export const inset = "flex flex-col gap-3 rounded-lg border border-border p-3";
/** One card of a grid. */
export const card = "flex min-w-0 flex-col rounded-lg bg-card shadow-card";
/** Grids that fit as many columns as their width holds, down to one. */
export const grid2 = "grid grid-cols-[repeat(auto-fit,minmax(min(17rem,100%),1fr))] gap-3";
export const grid3 = "grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3";
/** The square that leads a card or a row: an icon, or a monogram. */
export const tile = "grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground [&_svg]:size-4";

/** Loading, or why it failed with a way to try again; nothing once there is data. */
export function QueryState({ loading, error, retrying, onRetry, what = "reach OpenLive's agent" }: {
  loading: boolean; error: unknown; retrying: boolean; onRetry: () => void; what?: string;
}) {
  if (loading) return <p role="status" className="text-label text-muted-foreground">Loading…</p>;
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t {what}. {msg(error)}</span>
      <Button size="sm" onClick={onRetry} disabled={retrying}>{retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry</Button>
    </div>
  );
}

/** A list with nothing in it yet: what goes here, and the ways to add some. */
export function EmptyState({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-card-x py-5 text-center">
      <p className="text-label text-muted-foreground">{children}</p>
      {actions && <span className="flex flex-wrap justify-center gap-1.5">{actions}</span>}
    </div>
  );
}

export function NoMatch({ what, query }: { what: string; query: string }) {
  return <p className="break-words text-label text-muted-foreground">No {what} matches &ldquo;{query.trim()}&rdquo;.</p>;
}

/** A description kept to one line, its whole text in a tooltip when cut. */
export function OneLine({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip label={text} truncated className="flex min-w-0 max-w-full">
      <span className={cn("min-w-0 truncate", className)}>{text}</span>
    </Tooltip>
  );
}

export function BuiltInBadge() {
  return <Badge><Lock aria-hidden /> Built-in</Badge>;
}
