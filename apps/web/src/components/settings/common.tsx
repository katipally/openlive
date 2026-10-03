"use client";

import { useRef, type ReactNode } from "react";
import { Loader2, Lock, MoreHorizontal, RotateCcw, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, Button, ConfirmButton, ListGroup, Tooltip, dotTone, linkClass, menuItem, menuPanel, useMenu, type DotTone } from "@/components/ui";
import { MODE_LABEL, useUi } from "@/lib/uiStore";

// What every settings page shares: loading, failure, empty and no-match states,
// the one-line description, a status as a dot and a word, the ⋯ menu, the
// status card, and the class lists of fields, panels and card grids.

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
/** A grid that fits as many columns as its width holds, down to one. */
export const grid2 = "grid grid-cols-[repeat(auto-fit,minmax(min(17rem,100%),1fr))] gap-3";
/** The square that leads a card or a row: an icon, or a monogram. */
export const tile = "grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground [&_svg]:size-4";

/** Row-shaped placeholders while a page loads. They wait a beat before fading
 *  in (.ol-skeleton), so a quick load never flashes them. */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" className="ol-skeleton">
      <span className="sr-only">Loading</span>
      <ListGroup>
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} aria-hidden className="flex min-h-row flex-col justify-center gap-1.5 py-2">
            <span className="h-2.5 w-1/2 rounded-full bg-foreground/[0.07]" />
            <span className="h-2 w-1/3 rounded-full bg-foreground/[0.05]" />
          </span>
        ))}
      </ListGroup>
    </div>
  );
}

/** Loading, or why it failed with a way to try again; nothing once there is data. */
export function QueryState({ loading, error, retrying, onRetry, what = "reach OpenLive's agent" }: {
  loading: boolean; error: unknown; retrying: boolean; onRetry: () => void; what?: string;
}) {
  if (loading) return <LoadingRows />;
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t {what}. {msg(error)}</span>
      <Button size="sm" onClick={onRetry} disabled={retrying}>{retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry</Button>
    </div>
  );
}

/** A list with nothing in it yet: what goes here, and the ways to add some. */
export function EmptyState({ children, actions, icon: Icon }: { children: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-card-x py-5 text-center">
      {Icon && <span className={tile}><Icon aria-hidden /></span>}
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

/** Where something stands, as a dot and a word (Ready, Sign in needed). */
/** Whether Flow or Dictate is on, as Settings says it: the switch is on the mode's home, one press away. */
export function ModeOnLine({ id, mode, on }: { id: string; mode: "flow" | "dictate"; on: boolean }) {
  const name = MODE_LABEL[mode];
  // A call keeps Chat on screen, so there is no home to go to until it ends.
  const inCall = useUi((s) => s.liveOpen);
  const go = () => { useUi.getState().closeSettings(); useUi.getState().setMode(mode); };
  return (
    <p id={id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
      <StatusDot tone={on ? "success" : "muted"}>{name} is {on ? "on" : "off"}.</StatusDot>
      {!inCall && <button type="button" onClick={go} className={cn(linkClass, "text-caption")}>Turn it {on ? "off" : "on"} in {name}</button>}
    </p>
  );
}

export function StatusDot({ tone, children }: { tone: DotTone; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotTone(tone))} />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

export interface MenuAction {
  label: string;
  icon?: LucideIcon;
  run: () => void;
  /** Asks once, in place, before running (Uninstall, Sign out). */
  confirm?: string;
}

/** The ⋯ that holds a card's or a row's actions past its one button. Absent with none. */
export function MoreMenu({ label, actions }: { label: string; actions: readonly MenuAction[] }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(root, panel);
  if (!actions.length) return null;
  return (
    <div ref={root} className="relative shrink-0">
      <Tooltip label={label}>
        <Button variant="ghost" size="sm" icon onClick={toggle} aria-label={label} aria-haspopup="menu" aria-expanded={open}>
          <MoreHorizontal />
        </Button>
      </Tooltip>
      {mounted && (
        <div ref={panel} role="menu" aria-label={label}
          className={cn("absolute right-0 top-full z-overlay mt-1 flex w-max min-w-[9rem] max-w-[min(18rem,90vw)] origin-top-right flex-col", menuPanel)}>
          {actions.map((a) => a.confirm
            ? <ConfirmButton key={a.label} role="menuitem" label={a.label} confirm={a.confirm} className="w-full text-left"
                onConfirm={() => { requestClose(); a.run(); }} />
            : (
              <button key={a.label} type="button" role="menuitem" onClick={() => { requestClose(); a.run(); }}
                className={cn(menuItem, "text-label font-medium")}>
                {a.icon && <a.icon aria-hidden className="size-3.5 shrink-0" />}
                <span className="min-w-0 break-words">{a.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** One thing to set up (an agent, a connector): its mark and name, where it
 *  stands, the one thing to do next, and the rest under ⋯. `aside` is a quiet
 *  icon button before the ⋯ (shown or hidden); `children` is the card's body
 *  when it opens up (versions, paths). */
export function StatusCard({ icon, name, detail, tone, status, action, aside, more = [], children, className }: {
  icon: ReactNode; name: string; detail?: string; tone: DotTone; status: string;
  action?: ReactNode; aside?: ReactNode; more?: readonly MenuAction[]; children?: ReactNode; className?: string;
}) {
  return (
    <div className={cn(card, "gap-3 p-card-x", className)}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={tile}>{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <OneLine text={name} className="text-body font-medium text-foreground" />
          {detail && <OneLine text={detail} className="text-caption text-faint" />}
        </span>
        {aside}
        <MoreMenu label={`More for ${name}`} actions={more} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1"><StatusDot tone={tone}>{status}</StatusDot></span>
        {action}
      </div>
      {children}
    </div>
  );
}
