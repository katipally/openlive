"use client";

import { useCallback, useId, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useIsPresent } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { flowBridge } from "@/lib/flow/bridge";
import { clock, dayLabel, duration, stamp } from "@/lib/flow/format";
import { deleteWithUndo, refreshFlowSessions, renameFlowSession, useFlowSession } from "@/lib/flow/sessions";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useMotionTokens } from "@/lib/motion";
import { Event, brainLine, headline, lineOf } from "./FlowHistory";

// One Flow session over the home list. A sheet on a narrow window, a card up to
// 48rem on a wide one; the body scrolls, the header and the options do not.
// The card scales in, the sheet slides up; which one is fixed when it opens.

// A spring on a full-height sheet trails for a visible while; an eased slide lands.
const SHEET_S = 0.3;

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
  const { spring, fade, reduce } = useMotionTokens();
  const [wide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 40rem)").matches);
  const away = wide ? { opacity: 0, scale: 0.97 } : { y: "100%" };

  const entries = (data?.entries ?? []).filter((e) => e.type !== "session_state");
  const first = entries[0]?.timestamp ?? data?.header?.createdAt ?? "";
  const last = entries[entries.length - 1]?.timestamp ?? first;
  const ms = new Date(last).getTime() - new Date(first).getTime();
  const title = headline(data);

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
    const text = entries.map((e) => `${stamp(e.timestamp)}  ${lineOf(e)}`).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className={cn("fixed inset-0 z-[var(--z-modal)] flex items-center justify-center sm:p-6", !present && "pointer-events-none")}>
      <motion.div className="absolute inset-0 bg-black/40" onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
      <MotionConfig transition={spring}>
      <motion.div initial={away} animate={{ opacity: 1, scale: 1, y: 0 }} exit={away}
        transition={wide ? { ...spring, opacity: fade } : { ...fade, duration: reduce ? 0 : SHEET_S }}
        className="relative flex h-dvh w-full max-w-[48rem] flex-col bg-card shadow-[var(--shadow-pop)] sm:h-auto sm:max-h-full sm:rounded-2xl">
        <header className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {renaming ? (
              <RenameInput initial={title} onDone={rename} className="text-title font-semibold" />
            ) : (
              <h2 id={titleId} className="line-clamp-3 break-words text-title font-semibold">&ldquo;{title}&rdquo;</h2>
            )}
            <p className="text-caption text-muted-foreground">
              {[dayLabel(first), clock(first), Number.isFinite(ms) && ms > 0 ? duration(ms) : "", data && brainLine(data.header)]
                .filter(Boolean).join(" · ")}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
            <X className="size-5" />
          </button>
        </header>

        <motion.div layoutScroll className="openlive-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-3 shadow-[inset_0_1px_0_var(--border)]">
          {error && <Line>{String((error as Error).message)}</Line>}
          {isLoading && <Line>Opening&hellip;</Line>}
          {!isLoading && !error && !entries.length && <Line>This session has nothing in it.</Line>}
          {entries.map((e) => <Event key={e.id} entry={e} sessionId={id} assets={data?.assets ?? []} onZoom={setZoom} />)}
          {data?.truncated && (
            <p className="text-caption text-muted-strong">
              The end of this session was never finished being written, so the last line was left out.
            </p>
          )}
        </motion.div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3.5 shadow-[inset_0_1px_0_var(--border)]">
          <button type="button" onClick={() => flowBridge()?.resumeSession(id)} className={GHOST}>
            <Play className="size-3.5" aria-hidden /> Carry on
          </button>
          <button type="button" onClick={copy} disabled={!entries.length} className={GHOST}>Copy</button>
          <span title={live ? RUNNING_TIP : undefined}>
            <button type="button" onClick={() => setRenaming(true)} disabled={live || !data} className={GHOST}>Rename</button>
          </span>
          <span title={live ? RUNNING_TIP : undefined}>
            <ConfirmButton onConfirm={remove} disabled={live || !data} label="Delete" confirm="Delete session?" />
          </span>
          <span className="min-w-0 flex-1 truncate text-caption text-destructive-text">{failed}</span>
          <button type="button" onClick={onClose} className={GHOST}>Close</button>
        </footer>

        <AnimatePresence>
          {zoom && (
            <motion.button key="zoom" type="button" onClick={() => setZoom(null)} aria-label="Close picture"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}
              className="absolute inset-0 grid place-items-center bg-black/80 p-4 active:scale-100 sm:rounded-2xl">
              <motion.img layoutId={zoom} src={zoom} alt="" className="max-h-full max-w-full rounded-md object-contain" />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
      </MotionConfig>
    </div>
  );
}

const GHOST = "flex items-center gap-1.5 rounded-full px-3.5 py-2 text-label font-medium transition hover:bg-foreground/[0.06] disabled:opacity-40 disabled:hover:bg-transparent";

const Line = ({ children }: { children: React.ReactNode }) => (
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
      className={cn("w-full min-w-0 rounded-lg border border-border-heavy bg-surface px-2 py-1 text-foreground outline-none focus:border-accent", className)} />
  );
}

/** A delete that asks once, in place: the first press arms it, the second runs it,
 *  and leaving it disarms it. */
export function ConfirmButton({ label, confirm, onConfirm, disabled, className, role }: {
  label: string; confirm: string; onConfirm: () => void | Promise<unknown>; disabled?: boolean; className?: string; role?: "menuitem";
}) {
  const [armed, setArmed] = useState(false);
  const { spring, fade } = useMotionTokens();
  // The button eases to its new width while the words cross-fade inside it.
  return (
    <motion.button type="button" role={role} disabled={disabled} onBlur={() => setArmed(false)} layout transition={spring} style={{ borderRadius: 999 }}
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else setArmed(true); }}
      className={cn("relative px-3.5 py-2 text-label font-medium transition-colors disabled:opacity-40",
        armed ? "bg-destructive-fill text-white hover:opacity-90" : "text-destructive-text hover:bg-destructive/10 disabled:hover:bg-transparent", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={armed ? "confirm" : "label"} layout="position" className="inline-block whitespace-nowrap"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
          {armed ? confirm : label}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
