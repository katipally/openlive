"use client";

import { memo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { AlertCircle, AppWindow, ChevronRight, CircleDashed, Hand, MessageSquareText, Slash, Volume2 } from "lucide-react";
import { AGENT_REGISTRY, isAgentId } from "@openlive/shared";
import { cn } from "@/lib/cn";
import type { Part } from "@/lib/chatStore";
import { toolMeta } from "@/lib/live/toolMeta";
import { formatDuration, summarizeWork, type Segment, type ToolPart } from "@/lib/live/timeline";
import { stamp } from "@/lib/flow/format";
import { assetUrl, type FlowSessionDetail } from "@/lib/flow/sessions";
import { statusWord, type FlowItem, type FlowTimeline, type FlowTool } from "@/lib/flow/sessionTimeline";
import { Disclosure, Tooltip } from "@/components/ui";

// How one Flow session reads: its headline, who answered, and its timeline, in
// the in-call Activity's own terms: your words in a bubble, the reply as plain
// text, each tool one row that holds its outcome, runs of tools folded.

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Who answered, read from the header the session opened with.
 *
 * Sessions written before the header carried a brain say so rather than
 * claiming API mode answered them, which is what the old fallback did for every
 * coding-agent session ever recorded.
 */
export function brainLine(header: FlowSessionDetail["header"] | undefined): string {
  const raw = header?.brain;
  if (!raw || typeof raw !== "object") return "Not recorded";
  const b = raw as { kind?: string; id?: string; model?: string; effort?: string };
  const name = b.kind === "acp"
    ? (isAgentId(b.id ?? "") ? AGENT_REGISTRY[b.id as keyof typeof AGENT_REGISTRY].label : b.id || "A coding agent")
    : "API mode";
  return [name, b.model, b.effort && `${b.effort} effort`].filter(Boolean).join(" · ");
}

/** What a session is called: its own title, else the first thing that was said.
 *  Derived here rather than taken from the listing, so a transcript opened by
 *  URL still leads with the sentence instead of with "Flow session". */
export function headline(data: FlowSessionDetail | undefined): string {
  const given = str(data?.header?.title).trim();
  if (given) return given;
  const said = (data?.entries ?? []).find((e) => e.type === "message" && e.role === "user" && str(e.text).trim());
  return str(said?.text).trim() || "Flow session";
}

type Ctx = { tools: FlowTimeline["tools"]; sessionId: string; onZoom: (url: string) => void };

// Memoized, and each item skips layout and paint while off screen (ol-cv), so a
// session of hundreds of events opens and scrolls without a virtual list.
export const TimelineItem = memo(function TimelineItem({ item, ...ctx }: { item: FlowItem } & Ctx) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ol-cv group/item flex items-end justify-end gap-2">
          <When at={item.at} />
          <p className="ol-selectable max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-md bg-accent-soft px-3 py-1.5 text-body text-foreground">{item.text}</p>
        </div>
      );
    case "reply": {
      const how = item.spoken ? "Said out loud" : "Shown, not spoken";
      return (
        <div className="ol-cv group/item flex flex-col gap-1">
          <p className="ol-selectable whitespace-pre-wrap break-words text-body text-foreground">{item.text}</p>
          <span className="flex items-center gap-2">
            <Tooltip label={how}>
              <span tabIndex={0} role="img" aria-label={how} className="grid text-faint">
                {item.spoken ? <Volume2 aria-hidden className="size-3" /> : <MessageSquareText aria-hidden className="size-3" />}
              </span>
            </Tooltip>
            <When at={item.at} />
          </span>
        </div>
      );
    }
    case "tools":
      return <div className="ol-cv flex flex-col">{item.segments.map((s, i) => <Step key={i} seg={s} {...ctx} />)}</div>;
    case "app":
      return <Marker icon={<AppWindow aria-hidden />} at={item.at}>{[item.app, item.window].filter(Boolean).join(" · ")}</Marker>;
    case "stop":
      return <Marker icon={<Hand aria-hidden />} at={item.at}>You stopped it</Marker>;
  }
});

/** The time, small and out of the way until the row is pointed at. */
const When = ({ at }: { at: string }) => (
  <time dateTime={at} className="shrink-0 whitespace-nowrap text-micro tabular-nums text-faint opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100">
    {stamp(at)}
  </time>
);

/** A quiet line across the timeline: the app in front changed, or you stopped it. */
function Marker({ icon, at, children }: { icon: ReactNode; at: string; children: string }) {
  return (
    <div className="group/item flex min-w-0 items-center gap-2 text-caption text-faint [&_svg]:size-3 [&_svg]:shrink-0">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      {icon}
      <Tooltip label={children} truncated className="min-w-0">
        <span data-truncates className="truncate">{children}</span>
      </Tooltip>
      <When at={at} />
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

function Step({ seg, ...ctx }: { seg: Segment } & Ctx) {
  if (seg.kind === "step") return <Row part={seg.part} {...ctx} />;
  if (seg.kind === "work") return <WorkGroup parts={seg.parts} startedAt={seg.startedAt} endedAt={seg.endedAt} {...ctx} />;
  return null;
}

/** A run of tools, folded to one line that says what it did and how long it
 *  took, as the call's Activity folds a turn's work. */
function WorkGroup({ parts, startedAt, endedAt, ...ctx }: { parts: Part[]; startedAt?: number; endedAt?: number } & Ctx) {
  const [open, setOpen] = useState(false);
  const tools = parts.filter((p): p is ToolPart => p.kind === "tool");
  const failed = tools.filter((t) => t.kind === "tool" && t.detail === "error").length;
  const summary = summarizeWork(tools);
  const took = startedAt && endedAt ? formatDuration(endedAt - startedAt) : null;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex min-h-7 w-full min-w-0 items-center gap-1.5 text-left text-label text-muted-foreground transition hover:text-foreground">
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span className="min-w-0 truncate">
          {summary.label}
          {summary.multiKind && <span className="text-faint"> · {tools.length} steps</span>}
          {took && <span className="text-faint"> · {took}</span>}
        </span>
        {failed > 0 && <span className="flex shrink-0 items-center gap-1 text-destructive-text"><AlertCircle aria-hidden className="size-3" />{failed} failed</span>}
      </button>
      <Disclosure open={open}>
        <div className="ml-1.5 flex flex-col gap-1 border-l border-border py-1 pl-3.5">
          {tools.map((p, i) => <Row key={p.kind === "tool" && p.id ? p.id : i} part={p} {...ctx} />)}
        </div>
      </Disclosure>
    </div>
  );
}

function Row({ part, tools, sessionId, onZoom }: { part: ToolPart } & Ctx) {
  const t = part.kind === "tool" && part.id ? tools.get(part.id) : undefined;
  return t ? <ToolRow tool={t} sessionId={sessionId} onZoom={onZoom} /> : null;
}

const QUIET = new Set<FlowTool["status"]>(["stopped", "declined", "unanswered"]);

/** One tool, call and outcome together: its icon or state, what it did, how
 *  long, and the arguments one tap away when there were any. What it saw sits
 *  under it as thumbnails that open larger. */
function ToolRow({ tool: t, sessionId, onZoom }: { tool: FlowTool; sessionId: string; onZoom: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = toolMeta(t.name).icon;
  const failed = t.status === "failed";
  const has = !!t.args;
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" onClick={() => has && setOpen((v) => !v)} aria-expanded={has ? open : undefined}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-label text-muted-foreground", has ? "transition hover:text-foreground" : "cursor-default")}>
        {failed ? <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive-text" />
          : QUIET.has(t.status) ? <Slash aria-hidden className="size-3.5 shrink-0 text-faint" />
          : t.status === "running" ? <CircleDashed aria-hidden className="size-3.5 shrink-0 text-faint" />
          : <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />}
        <Tooltip label={t.name} className="min-w-0">
          <span className={cn("truncate", failed && "text-destructive-text")}>{t.label}</span>
        </Tooltip>
        {t.status !== "done" && <span className={cn("shrink-0 text-micro", failed ? "text-destructive-text" : "text-faint")}>{statusWord(t.status)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {typeof t.ms === "number" && t.ms >= 0 && <span className="text-micro tabular-nums text-faint">{formatDuration(t.ms)}</span>}
          {/* Held even when there is nothing to open, so every duration lines up. */}
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", !has && "invisible", open && "rotate-90")} />
        </span>
      </button>
      {has && (
        <Disclosure open={open}>
          <dl className="ol-selectable grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pb-1.5 pl-5.5 pt-0.5 text-caption">
            {t.args!.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="whitespace-pre-wrap break-words font-mono text-muted-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
      {t.shots.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1 pl-5.5 pt-1">
          {t.shots.map((name) => {
            const url = assetUrl(sessionId, name);
            return (
              <button key={name} type="button" onClick={() => onZoom(url)} aria-label={`Open what "${t.label}" saw`}
                className="overflow-hidden rounded-md bg-surface-raised shadow-xs ring-1 ring-border transition hover:ring-border-heavy">
                <motion.img layoutId={url} src={url} alt="" loading="lazy" decoding="async" className="h-16 w-auto max-w-[8rem] object-cover" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
