"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { ImageIcon, MoreHorizontal, Search, Settings2 } from "lucide-react";
import { AGENT_REGISTRY, isAgentId } from "@openlive/shared";
import { Keycap } from "@/components/Keycap";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import {
  deleteWithUndo, refreshFlowSessions, renameFlowSession, sessionLine, useFlowSessionPages, pendingSessionKey, type FlowSessionSummary,
} from "@/lib/flow/sessions";
import type { FlowCapabilities } from "@/lib/flow/bridge";
import { usePendingDeletes } from "@/lib/deferredDelete";
import { useMenuKeys } from "@/lib/useMenuKeys";
import { CONTROL } from "@/lib/platform";
import { useUi } from "@/lib/uiStore";
import { clock, dayLabel, duration } from "@/lib/flow/format";
import { FlowCanvas } from "./FlowCanvas";
import { ConfirmButton, FlowSessionModal, RenameInput, RUNNING_TIP } from "./FlowSessionModal";
import { cn } from "@/lib/cn";
import { POP, useMotionTokens } from "@/lib/motion";

// One page, like Chat's home: how to start and whether Flow is live, then what
// the person actually said, most recent first. A session opens over it.

const FIRST = 8;
const PAGE = 40;
const SEARCH_DEBOUNCE_MS = 200;
// Rows arriving together enter one after another, this far apart, and the
// stagger stops growing after STAGGER_MAX rows so a long page never trails.
const STAGGER_S = 0.03;
const STAGGER_MAX = 10;

export function FlowHome({ sessionId, onOpen, caps }: {
  sessionId: string | null; onOpen: (id: string | null) => void; caps: FlowCapabilities | null;
}) {
  const { config } = useFlowConfig();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const { fade } = useMotionTokens();
  const openSettingsTab = useUi((s) => s.openSettingsTab);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(typed.trim()); setPicked(new Set()); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const { data, isLoading, error, isFetching, isPlaceholderData, hasNextPage, fetchNextPage, isFetchingNextPage } = useFlowSessionPages(query, FIRST, PAGE);
  const hidden = usePendingDeletes((s) => s.keys);
  const sessions = useMemo(() => (data?.pages.flat() ?? []).filter((s) => !hidden.has(pendingSessionKey(s.id))), [data, hidden]);
  // Place within its own page, so "See more" staggers only the rows it brought.
  const order = useMemo(() => new Map(data?.pages.flatMap((p) => p.map((s, j) => [s.id, j] as const))), [data]);
  // The query whose results are on screen: while the next one loads, the last
  // one's rows stay up, and the list cross-fades once they are replaced.
  const [shown, setShown] = useState(query);
  if (!isPlaceholderData && shown !== query) setShown(query);
  const deletable = useMemo(() => sessions.filter((s) => s.state !== "active"), [sessions]);
  const groups = useMemo(() => byDay(sessions), [sessions]);

  const hookError = caps?.hookError;
  const armed = !!caps?.armed && !!caps.permissions?.accessibility && !hookError;
  const all = deletable.length > 0 && deletable.every((s) => picked.has(s.id));

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const done = () => { setSelecting(false); setPicked(new Set()); };
  const removePicked = () => {
    deleteWithUndo([...picked], qc);
    setPicked(new Set());
  };

  return (
    <FlowCanvas className="max-w-[46rem] gap-8">
      <section className="flex flex-col items-center gap-5 text-center">
        <OpenLiveOrb size={84} pulse />
        <div className="space-y-2">
          <h1 className="text-display font-semibold tracking-tight">Flow</h1>
          <p className="text-callout leading-relaxed text-muted-foreground">
            Tap <Keycap className="text-label">{CONTROL}</Keycap> <Keycap className="text-label">{CONTROL}</Keycap> anywhere to talk.
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          <BrainChip config={config} />
          {caps && (
            <span className="relative flex shrink-0 items-center gap-2 rounded-full bg-surface-raised px-3 py-1 text-caption text-muted-strong" title={hookError || undefined}>
              <span className={cn("size-1.5 rounded-full transition-colors duration-300", armed ? "bg-success" : hookError ? "bg-destructive-fill" : "bg-muted-foreground")} aria-hidden />
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={hookError ? "stopped" : armed ? "ready" : "off"} transition={fade}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
                  {hookError ? "Key listener stopped" : armed ? "Ready" : "Off"}
                </motion.span>
              </AnimatePresence>
            </span>
          )}
          {/* Stretched to the row, so it stands exactly as tall as the chips beside it. */}
          <button type="button" onClick={() => openSettingsTab("flow")} title="Flow settings" aria-label="Flow settings"
            className="flex shrink-0 items-center self-stretch rounded-full bg-surface-raised px-2.5 text-muted-strong transition hover:bg-foreground/10 hover:text-foreground">
            <Settings2 className="size-3.5" aria-hidden />
          </button>
        </div>
        {hookError && <p className="max-w-full truncate text-caption text-destructive-text" title={hookError}>{hookError}</p>}
      </section>

      <section className="flex flex-col gap-2.5">
        <label className="flex items-center gap-2.5 rounded-lg bg-card px-3.5 py-2.5 shadow-[var(--shadow-card)]">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="sr-only">Search what you said</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} type="search" placeholder="Search what you said"
            className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
          {isFetching && !isFetchingNextPage && <span className="shrink-0 text-caption text-muted-foreground">Looking&hellip;</span>}
        </label>

        <div className="relative flex min-h-9 px-1">
          <AnimatePresence mode="popLayout" initial={false}>
          {selecting ? (
            <motion.div key="select" {...CROSSFADE} transition={fade} className={HEADER}>
              <label className="flex shrink-0 items-center gap-2 text-label text-muted-strong">
                <Tick checked={all} disabled={!deletable.length}
                  onChange={() => setPicked(all ? new Set() : new Set(deletable.map((s) => s.id)))} />
                Select all
              </label>
              <span className="min-w-0 flex-1 truncate text-label tabular-nums text-muted-foreground">{picked.size} selected</span>
              <ConfirmButton key={picked.size} label="Delete" confirm={`Delete ${picked.size}?`} disabled={!picked.size} onConfirm={removePicked} />
              <button type="button" onClick={done}
                className="shrink-0 rounded-full px-3.5 py-2 text-label font-medium transition hover:bg-foreground/[0.06]">
                Done
              </button>
            </motion.div>
          ) : (
            <motion.div key="browse" {...CROSSFADE} transition={fade} className={HEADER}>
              <h2 className="min-w-0 flex-1 truncate text-title-sm font-semibold">{query ? "Matches" : "Recent"}</h2>
              <button type="button" onClick={() => setSelecting(true)} disabled={!sessions.length}
                className="shrink-0 rounded-full px-3.5 py-2 text-label font-medium transition hover:bg-foreground/[0.06] disabled:opacity-40 disabled:hover:bg-transparent">
                Select
              </button>
            </motion.div>
          )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col rounded-xl bg-card p-1.5 shadow-[var(--shadow-card)]">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div key={shown} {...CROSSFADE} transition={fade} className="flex flex-col">
          {error && <Empty>Flow&rsquo;s history could not be read.</Empty>}
          {!error && isLoading && <Empty>Looking&hellip;</Empty>}
          {!error && !isLoading && !sessions.length && (
            <Empty>{shown ? `Nothing matching \u201c${shown}\u201d.` : `Nothing yet. Tap ${CONTROL} twice and say something.`}</Empty>
          )}
          <AnimatePresence>
          {groups.flatMap((g) => [
            <motion.span key={`day:${g.day}`} {...CROSSFADE} exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }} transition={fade}
              className="overflow-hidden px-3.5 pb-1 pt-3 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">{g.day}</motion.span>,
            ...g.rows.map((s, i) => (
              <SessionRow key={s.id} session={s} first={i === 0} onOpen={() => onOpen(s.id)}
                delay={Math.min(order.get(s.id) ?? 0, STAGGER_MAX) * STAGGER_S}
                selecting={selecting} picked={picked.has(s.id)} onToggle={() => toggle(s.id)} />
            )),
          ])}
          </AnimatePresence>
          </motion.div>
          </AnimatePresence>
          {hasNextPage && (
            <button type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}
              className="m-1.5 rounded-md bg-surface-raised px-4 py-2.5 text-label font-medium transition hover:bg-foreground/10 disabled:opacity-60">
              {isFetchingNextPage ? "Looking\u2026" : "See more"}
            </button>
          )}
        </div>
      </section>

      <AnimatePresence>
        {sessionId && (
          <FlowSessionModal key={sessionId} id={sessionId} live={sessions.some((s) => s.id === sessionId && s.state === "active")} onClose={() => onOpen(null)} />
        )}
      </AnimatePresence>
    </FlowCanvas>
  );
}

const CROSSFADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } as const;
const HEADER = "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1";

/** Consecutive rows that share a day. Derived, so an empty day never appears. O(n). */
function byDay(sessions: FlowSessionSummary[]) {
  const out: { day: string; rows: FlowSessionSummary[] }[] = [];
  for (const s of sessions) {
    const day = dayLabel(s.createdAt) || "Earlier";
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(s);
    else out.push({ day, rows: [s] });
  }
  return out;
}

function Empty({ children }: { children: React.ReactNode }) {
  const { fade } = useMotionTokens();
  return (
    <motion.p {...CROSSFADE} transition={fade}
      className="m-auto max-w-[32rem] break-words px-6 py-10 text-center text-body leading-relaxed text-muted-strong">{children}</motion.p>
  );
}

/** A checkbox that springs in and draws its tick. The real input sits on top,
 *  invisible, so keyboard, labels and forms behave exactly as native. */
function Tick({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  const { spring, fade } = useMotionTokens();
  return (
    <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} whileTap={disabled ? undefined : { scale: 0.88 }}
      transition={spring}
      className={cn("relative grid size-4 shrink-0 place-items-center rounded-[5px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50",
        checked ? "bg-accent" : "bg-surface shadow-[inset_0_0_0_1.5px_var(--border-heavy)]")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange}
        className="absolute inset-0 m-0 cursor-[inherit] appearance-none opacity-0" />
      <svg viewBox="0 0 16 16" className="pointer-events-none size-3 text-accent-foreground" aria-hidden>
        <motion.path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
          initial={false} animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }} transition={fade} />
      </svg>
    </motion.span>
  );
}

function BrainChip({ config }: { config: ReturnType<typeof useFlowConfig>["config"] }) {
  const choice = useApiModeChoice();
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const brain = config?.brain;
  const acp = brain?.kind === "acp";
  const label = !brain ? "\u2026"
    : brain.kind === "acp" ? (isAgentId(brain.agentId) ? AGENT_REGISTRY[brain.agentId].label : brain.agentId || "No agent chosen")
    : `API mode \u00b7 ${choice.loading ? "\u2026" : choice.model}`;
  return (
    <button type="button" onClick={() => openSettingsTab("flow")} title="Change the brain"
      className="flex min-w-0 max-w-full items-center gap-2 rounded-full bg-surface-raised px-3 py-1 text-caption text-foreground transition hover:bg-foreground/10">
      <span className={cn("size-[7px] shrink-0 rounded-full", acp ? "bg-arc" : "bg-accent")} aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function SessionRow({ session, first, delay, onOpen, selecting, picked, onToggle }: {
  session: FlowSessionSummary; first: boolean; delay: number; onOpen: () => void; selecting: boolean; picked: boolean; onToggle: () => void;
}) {
  const qc = useQueryClient();
  const present = useIsPresent();
  const { fade, reduce } = useMotionTokens();
  const [renaming, setRenaming] = useState(false);
  const live = session.state === "active";
  const ms = new Date(session.updatedAt).getTime() - new Date(session.createdAt).getTime();
  const line = sessionLine(session);

  const rename = async (next: string | null) => {
    setRenaming(false);
    if (next !== null && next.trim() !== line && (await renameFlowSession(session.id, next))) await refreshFlowSessions(qc);
  };

  const body = (
    <>
      <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{clock(session.createdAt)}</span>
      {renaming
        ? <RenameInput initial={line} onDone={rename} className="flex-1 text-callout" />
        : <span className="min-w-0 flex-1 truncate text-callout" title={line}>&ldquo;{line}&rdquo;</span>}
      {session.state === "crash" && (
        <span className="shrink-0 rounded-full bg-destructive/10 px-2.5 py-0.5 text-caption text-destructive-text">Ended unexpectedly</span>
      )}
      {session.assets > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-caption tabular-nums text-muted-foreground"
          title={session.assets === 1 ? "One capture" : `${session.assets} captures`}>
          <ImageIcon className="size-3.5" aria-hidden /> {session.assets}
        </span>
      )}
      {Number.isFinite(ms) && ms > 0 && (
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{duration(ms)}</span>
      )}
    </>
  );
  const edge = cn("flex min-w-0 items-center rounded-md", !first && "shadow-[inset_0_1px_0_var(--border)]");
  const cells = "flex min-h-[3.25rem] min-w-0 flex-1 items-center gap-4 px-3.5 py-2 text-left";

  // Clipped only while leaving, so the collapse hides the row but the open
  // menu is never cut off by its own row.
  return (
    <motion.div className={cn(!present && "overflow-hidden")}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { ...fade, delay: reduce ? 0 : delay } }}
      exit={{ opacity: 0, height: 0, transition: fade }}>
      {selecting ? (
        <label title={live ? RUNNING_TIP : undefined}
          className={cn(edge, cells, "transition hover:bg-foreground/[0.05]", live ? "opacity-60" : "cursor-pointer")}>
          <Tick checked={picked} disabled={live} onChange={onToggle} />
          {body}
        </label>
      ) : renaming ? (
        <div className={cn(edge, cells)}>{body}</div>
      ) : (
        <div className={cn(edge, "group pr-1.5 transition hover:bg-foreground/[0.05]")}>
          <button type="button" onClick={onOpen} className={cn(cells, "active:scale-[0.99]")}>{body}</button>
          <RowMenu live={live} onRename={() => setRenaming(true)} onDelete={() => deleteWithUndo([session.id], qc)} />
        </div>
      )}
    </motion.div>
  );
}

/** Rename and Delete for one row. Closes on a press anywhere else, or Esc. */
function RowMenu({ live, onRename, onDelete }: { live: boolean; onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { fade } = useMotionTokens();

  useMenuKeys(root, open, () => setOpen(false));

  return (
    <div ref={root} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Session options" aria-haspopup="menu" aria-expanded={open}
        className={cn("grid size-8 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground",
          !open && "opacity-60 group-hover:opacity-100 focus-visible:opacity-100")}>
        <MoreHorizontal className="size-4" />
      </button>
      <AnimatePresence>
      {open && (
        <motion.div role="menu" aria-label="Session options" title={live ? RUNNING_TIP : undefined} {...POP} transition={fade} style={{ originX: 1, originY: 0 }}
          className="absolute right-0 top-full z-[var(--z-overlay)] mt-1 flex w-max min-w-[9rem] flex-col rounded-lg bg-card p-1 shadow-[var(--shadow-pop)]">
          <button type="button" role="menuitem" disabled={live} onClick={() => { setOpen(false); onRename(); }}
            className="rounded-full px-3.5 py-2 text-left text-label font-medium transition hover:bg-foreground/[0.06] disabled:opacity-40 disabled:hover:bg-transparent">
            Rename
          </button>
          <ConfirmButton role="menuitem" label="Delete" confirm="Delete session?" disabled={live} className="text-left"
            onConfirm={() => { setOpen(false); onDelete(); }} />
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
