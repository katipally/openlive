"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useIsPresent } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Pencil, Play, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, ConfirmButton, SidePanelHeader, Swap, Tooltip, sidePanel } from "@/components/ui";
import { flowBridge } from "@/lib/flow/bridge";
import { clock, dayLabel, duration, stamp } from "@/lib/flow/format";
import { deleteWithUndo, refreshFlowSessions, renameFlowSession, useFlowSession } from "@/lib/flow/sessions";
import { flowTimeline, startsTurn, timelineText } from "@/lib/flow/sessionTimeline";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useMotionTokens } from "@/lib/motion";
import { TimelineItem, brainLine, headline } from "./FlowEvent";

// One Flow session over the home list, drawn as a floating side panel: the
// header (title, when and who, close), the timeline scrolling between two
// hairlines, and the actions on the kit's buttons. A sheet on a narrow window,
// a card up to 48rem on a wide one; which one is fixed when it opens.

const COPIED_MS = 1200;

export const RUNNING_TIP = "Still running. It can be changed once it ends.";

export function FlowSessionModal({ id, live, onClose }: { id: string; live: boolean; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const qc = useQueryClient();
  const { data, isLoading, error } = useFlowSession(id);
  const [zoom, setZoom] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [failed, setFailed] = useState("");
  // Stable, because the trap re-runs (and re-grabs focus) whenever its callback changes.
  const latest = useRef({ zoom, onClose });
  latest.current = { zoom, onClose };
  const dismiss = useCallback(() => (latest.current.zoom ? setZoom(null) : latest.current.onClose()), []);
  useFocusTrap(root, true, dismiss);
  const present = useIsPresent();
  const { smooth, gentle, fade, sheet, exit: leave } = useMotionTokens();
  const [copied, setCopied] = useState(false);
  const [wide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 40rem)").matches);
  const away = wide ? { opacity: 0, scale: 0.97 } : { y: "100%" };

  const entries = useMemo(() => (data?.entries ?? []).filter((e) => e.type !== "session_state"), [data]);
  const timeline = useMemo(() => flowTimeline(entries, data?.assets ?? []), [entries, data]);
  const first = entries[0]?.timestamp ?? data?.header?.createdAt ?? "";
  const last = entries[entries.length - 1]?.timestamp ?? first;
  const ms = new Date(last).getTime() - new Date(first).getTime();
  const title = headline(data);
  const meta = [dayLabel(first), clock(first), Number.isFinite(ms) && ms > 0 ? duration(ms) : "", data && brainLine(data.header)].filter(Boolean).join(" · ");

  const rename = async (next: string | null) => {
    setRenaming(false);
    if (next === null || next.trim() === title) return;
    if (!(await renameFlowSession(id, next))) return setFailed("It could not be renamed.");
    setFailed("");
    void refreshFlowSessions(qc);
  };

  const remove = () => {
    deleteWithUndo([id], qc);
    onClose();
  };

  const copy = () => {
    navigator.clipboard.writeText(timelineText(timeline, stamp)).then(() => { setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }, () => {});
  };

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className={cn("ol-over-settings fixed inset-0 z-modal flex items-center justify-center sm:p-6", !present && "pointer-events-none")}>
      <motion.div className="absolute inset-0 scrim" onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: leave }} transition={fade} />
      <MotionConfig transition={gentle}>
      <motion.div initial={away} animate={{ opacity: 1, scale: 1, y: 0 }} exit={away}
        transition={wide ? { ...smooth, opacity: fade } : sheet}
        className={cn(sidePanel(true), "relative h-dvh w-full max-w-[48rem] overflow-hidden rounded-none sm:h-auto sm:max-h-full sm:rounded-xl")}>
        <SidePanelHeader titleId={titleId} detail={meta}
          title={renaming
            ? <RenameInput initial={title} onDone={rename} className="text-title-sm font-semibold" />
            : <Tooltip label={title} truncated className="flex max-w-full"><span data-truncates className="truncate">{title}</span></Tooltip>}>
          <Tooltip label="Close" keys="Esc">
            <Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close"><X /></Button>
          </Tooltip>
        </SidePanelHeader>

        <motion.div layoutScroll className="openlive-scroll flex min-h-0 flex-1 flex-col overflow-y-auto border-y border-border px-5 py-5">
          {error && <Empty>{String((error as Error).message)}</Empty>}
          {isLoading && <Empty>Opening&hellip;</Empty>}
          {!isLoading && !error && !timeline.items.length && <Empty>Nothing was said in this session.</Empty>}
          {timeline.items.map((item, i) => (
            <div key={item.id} className={i === 0 ? undefined : startsTurn(timeline.items[i - 1]!, item) ? "pt-turn" : "pt-beat"}>
              <TimelineItem item={item} tools={timeline.tools} sessionId={id} onZoom={setZoom} />
            </div>
          ))}
          {data?.truncated && (
            <p className="pt-turn text-caption text-muted-strong">
              The end of this session was never finished being written, so the last line was left out.
            </p>
          )}
        </motion.div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
          <Tooltip label={live && RUNNING_TIP}>
            <ConfirmButton onConfirm={remove} disabled={live || !data} label="Delete" confirm="Delete session?" />
          </Tooltip>
          <span role="status" className="min-w-0 flex-1 break-words text-caption text-destructive-text">{failed}</span>
          <Button variant="secondary" size="sm" onClick={copy} disabled={!timeline.items.length} aria-label={copied ? "Copied" : "Copy transcript"}>
            <Swap id={copied ? "done" : "copy"}>{copied ? <Check aria-hidden className="text-success-text" /> : <Copy aria-hidden />}</Swap>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Tooltip label={live && RUNNING_TIP}>
            <Button variant="secondary" size="sm" onClick={() => { if (!live && data) setRenaming(true); }} aria-disabled={live || !data || undefined}>
              <Pencil aria-hidden /> Rename
            </Button>
          </Tooltip>
          <Button variant="primary" size="sm" onClick={() => flowBridge()?.resumeSession(id)}>
            <Play aria-hidden /> Carry on
          </Button>
        </footer>

        <AnimatePresence>
          {zoom && (
            <motion.button key="zoom" type="button" onClick={() => setZoom(null)} aria-label="Close picture"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}
              className="absolute inset-0 grid place-items-center bg-black/80 p-4 active:scale-100">
              <motion.img layoutId={zoom} src={zoom} alt="" className="max-h-full max-w-full rounded-md object-contain" />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
      </MotionConfig>
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="m-auto px-6 py-10 text-center text-body text-muted-strong">{children}</p>
);

/** Enter or leaving the field saves, Esc cancels. `null` means cancelled. Esc is
 *  stopped here so a surrounding dialog does not close with it. */
export function RenameInput({ initial, onDone, className }: { initial: string; onDone: (title: string | null) => void; className?: string }) {
  const done = useRef(false);
  const { fade } = useMotionTokens();
  const finish = (v: string | null) => { if (!done.current) { done.current = true; onDone(v); } };
  return (
    <motion.input autoFocus defaultValue={initial} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade} spellCheck={false} maxLength={200} aria-label="Session name"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      }}
      className={cn("w-full min-w-0 rounded-md border border-border bg-control px-2 py-0.5 text-foreground shadow-xs outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/15", className)} />
  );
}
