"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { ImageIcon, Loader2, MoreHorizontal, Search, Settings2 } from "lucide-react";
import { menuItem, menuPanel, useMenu, Button, Tooltip, Input, Chip, pill, Checkbox, groupLabel, ConfirmButton, Badge, dotTone } from "@/components/ui";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { flowBrain } from "@openlive/flow-store/shared";
import { useAnswerLine, useDefaultBrain } from "@/components/settings/WhoAnswers";
import {
  deleteWithUndo, refreshFlowSessions, renameFlowSession, sessionLine, useFlowSessionPages, pendingSessionKey, type FlowSessionSummary,
} from "@/lib/flow/sessions";
import { flowBridge, type FlowCapabilities } from "@/lib/flow/bridge";
import { usePendingDeletes } from "@/lib/deferredDelete";
import { desktopPlatform, isMac } from "@/lib/platform";
import { keyName, liveKeys } from "@/lib/dictate/hotkey";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { clock, dayLabel, duration } from "@/lib/flow/format";
import { AddonCard } from "./AddonCard";
import { GrantPills, missingGrants } from "./GrantPills";
import { ModeSteps, modeCopy } from "./ModeSwitch";
import { PowerPill } from "./PowerPill";
import { FlowSessionModal, RenameInput, RUNNING_TIP } from "./FlowSessionModal";
import { cn } from "@/lib/cn";
import { SpotlightTour, type TourStep } from "@/components/SpotlightTour";
import { AgentIcon } from "@/components/live/AgentIcon";
import { staggerDelay, useMotionTokens } from "@/lib/motion";

// One page, like Chat's home: how to start and whether Flow is live, then what
// the person actually said, most recent first. A session opens over it.

const FIRST = 8;
const PAGE = 40;
const SEARCH_DEBOUNCE_MS = 200;

export function FlowHome({ sessionId, onOpen, caps, onRetry }: {
  sessionId: string | null; onOpen: (id: string | null) => void; caps: FlowCapabilities | null;
  /** Re-reads `caps`, for the addon card's "Try again". */
  onRetry: () => void;
}) {
  const { config } = useFlowConfig();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const { fade } = useMotionTokens();
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const settingsOpen = useUi((s) => s.settingsOpen);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(typed.trim()); setPicked(new Set()); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const { data, isLoading, error, isFetching, isPlaceholderData, hasNextPage, fetchNextPage, isFetchingNextPage } = useFlowSessionPages(query, FIRST, PAGE);
  // Leaving Flow keeps only the first page. Coming back would otherwise refetch
  // and mount every page "See more" ever loaded: 500 rows held the switch ~100 ms.
  useEffect(() => () => {
    qc.setQueriesData<InfiniteData<FlowSessionSummary[], number>>({ queryKey: ["flow-sessions", "pages"] },
      (d) => d && { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) });
  }, [qc]);
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

  const flowKey = config ? keyName(liveKeys(config.talk).flow, desktopPlatform) : "its key";
  const hookError = caps?.hookError;
  const armed = !!caps?.armed && !!caps.permissions?.accessibility && !hookError;
  // What it still needs from this machine has its fix right here, as Dictate's home does.
  const missing = caps?.armed && !hookError ? missingGrants(caps) : [];
  const all = deletable.length > 0 && deletable.every((s) => picked.has(s.id));
  const hasPower = !!caps && !caps.addonError;
  const hasStatus = missing.length > 0 || (!!caps?.armed && !caps.addonError);
  // Only the controls on screen right now get a step.
  const tour: TourStep[] = [
    ...hasPower ? [{ target: "flow-power", concept: "flowPower" as const, title: "Turn Flow on and off",
      body: `Double-tap ${flowKey} in any app to open Flow. This switch, or the ${isMac ? "menu bar" : "tray"} icon, turns that key off.` }] : [],
    { target: "flow-brain", title: "Who answers in Flow", body: "The default from Settings, or Flow's own. Tap it to change." },
    ...hasStatus ? [{ target: "flow-status", title: "Ready means it hears you", body: "When something's missing, this chip turns into the fix." }] : [],
    { target: "flow-history", title: "Everything you asked", body: "Search it, open a session to read it or carry on, and delete what you don't need. It stays on this machine." },
  ];

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
    // Anchored to the top, not centred: a centred page re-centres whenever the
    // list changes height (a search, a page, a delete, Select), and the hero moved
    // with it. The list scrolls in the room below the hero; only when the window
    // is too short for both does the whole page scroll.
    <div className="openlive-scroll fade-top fade-under-switch flex min-h-0 flex-1 flex-col overflow-y-auto">
    {/* The page's bar floats over this scroller (FlowShell), so it starts below it. */}
    <div aria-hidden className="h-14 shrink-0" />
    <div className="mx-auto flex w-full max-w-[37.5rem] flex-1 flex-col gap-11 px-6 pt-[clamp(1rem,6dvh,4rem)]">
      <section className="flex shrink-0 flex-col items-center gap-5 text-center">
        <OpenLiveOrb size={84} pulse paused={settingsOpen} />
        <div className="space-y-2">
          <h1 className="text-display font-semibold tracking-tight">Flow</h1>
          <p className="text-callout leading-relaxed text-muted-foreground">{modeCopy("flow").tagline}</p>
        </div>
        <ModeSteps mode="flow" on={caps?.armed !== false} />
        {caps && !caps.addonError && <PowerPill name="Flow" tour="flow-power" on={caps.armed} onFlip={() => flowBridge()?.setArmed(!caps.armed)} />}
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          <BrainChip config={config} />
          {missing.length ? <GrantPills mode="flow" tour="flow-status" missing={missing} refresh={onRetry} /> : caps?.armed && !caps.addonError && (
            <Tooltip label={hookError} className="flex min-w-0 max-w-full">
              <span data-tour="flow-status" className="flex min-w-0 max-w-full">
                <Chip dot={armed ? "success" : hookError ? "danger" : "muted"}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={hookError ? "stopped" : armed ? "ready" : "waiting"} transition={fade}
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
                      {hookError ? "Key listener stopped" : armed ? "Ready" : "Not ready yet"}
                    </motion.span>
                  </AnimatePresence>
                </Chip>
              </span>
            </Tooltip>
          )}
          <ChipButton onClick={() => openSettingsTab("flow")} tip="Flow settings" className="aspect-square justify-center px-0">
            <Settings2 aria-hidden /><span className="sr-only">Flow settings</span>
          </ChipButton>
        </div>
        {hookError && <p className="max-w-full break-words text-caption text-destructive-text">{hookError}</p>}
        {caps?.addonError && <AddonCard error={caps.addonError} packaged={caps.packaged} user="flow" onRetry={onRetry} />}
      </section>

      <section className="flex min-h-[16rem] flex-1 basis-0 flex-col gap-1">
        <div data-tour="flow-history" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-1 pb-2">
          <div className="relative flex min-h-control-sm min-w-0 flex-[1_1_10rem] items-center">
            <AnimatePresence mode="popLayout" initial={false}>
            {selecting ? (
              <motion.div key="select" {...CROSSFADE} transition={fade} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex shrink-0 items-center gap-2 text-label text-muted-strong">
                  <Checkbox checked={all} disabled={!deletable.length}
                    onChange={() => setPicked(all ? new Set() : new Set(deletable.map((s) => s.id)))} />
                  Select all
                </label>
                <span className="text-label tabular-nums text-muted-foreground">{picked.size} selected</span>
                <ConfirmButton key={picked.size} label="Delete" confirm={`Delete ${picked.size}?`} disabled={!picked.size} onConfirm={removePicked} />
              </motion.div>
            ) : (
              <motion.h2 key="browse" {...CROSSFADE} transition={fade} className="min-w-0 truncate text-title-sm font-semibold">
                {query ? "Matches" : "History"}
              </motion.h2>
            )}
            </AnimatePresence>
          </div>
          <Input type="search" icon={<Search />} value={typed} onChange={(e) => { if (!typed && e.target.value) featureUsed("n_flow_history_search"); setTyped(e.target.value); }} placeholder="Search what you said" aria-label="Search what you said" data-history-search="flow"
            className="min-w-[10rem] flex-[0_1_15rem]"
            trailing={isFetching && !isFetchingNextPage && <Loader2 className="animate-spin motion-reduce:animate-none" aria-label="Looking" />} />
          <Button variant="ghost" size="sm" onClick={selecting ? done : () => setSelecting(true)} disabled={!selecting && !sessions.length}>
            {selecting ? "Done" : "Select"}
          </Button>
        </div>

        <div className="openlive-scroll -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-8">
        <AnimatePresence mode="wait" initial={false}>
        <motion.div key={shown} {...CROSSFADE} transition={fade} className="flex flex-col">
        {error && <Empty>Couldn&rsquo;t read Flow&rsquo;s history.</Empty>}
        {!error && isLoading && <Empty>Looking&hellip;</Empty>}
        {!error && !isLoading && !sessions.length && (
          <Empty>{shown ? `Nothing matching \u201c${shown}\u201d.` : `Nothing yet. ${caps?.armed === false ? "Turn Flow on, then double-tap" : "Double-tap"} ${flowKey} and say something.`}</Empty>
        )}
        <AnimatePresence>
        {groups.flatMap((g) => [
          <motion.h3 key={`day:${g.rows[0]!.id}`} {...CROSSFADE} exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }} transition={fade}
            className={cn("overflow-hidden px-3 pb-1.5 pt-5", groupLabel)}>{g.day}</motion.h3>,
          ...g.rows.map((s) => (
            <SessionRow key={s.id} session={s} onOpen={() => { featureUsed("n_flow_history_open"); onOpen(s.id); }}
              delay={staggerDelay(order.get(s.id) ?? 0)}
              selecting={selecting} picked={picked.has(s.id)} onToggle={() => toggle(s.id)} />
          )),
        ])}
        </AnimatePresence>
        </motion.div>
        </AnimatePresence>
        {hasNextPage && (
          <Button variant="ghost" size="sm" className="mt-1 self-start" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Looking\u2026" : "See more"}
          </Button>
        )}
        </div>
      </section>

      <SpotlightTour id="flow" active={!sessionId && !!caps} steps={tour} />
      <AnimatePresence>
        {sessionId && (
          <FlowSessionModal key={sessionId} id={sessionId} live={sessions.some((s) => s.id === sessionId && s.state === "active")} onClose={() => onOpen(null)} />
        )}
      </AnimatePresence>
    </div>
    </div>
  );
}

const CROSSFADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } as const;

/** Something on the status row you can press: the kit's pill. */
export function ChipButton({ onClick, tip, tour, className, children }: { onClick: () => void; tip: string; tour?: string; className?: string; children: React.ReactNode }) {
  return (
    <Tooltip label={tip} className="min-w-0 max-w-full">
      <button type="button" data-tour={tour} onClick={onClick} className={cn(pill, "min-w-0 max-w-full", className)}>
        {children}
      </button>
    </Tooltip>
  );
}

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

function BrainChip({ config }: { config: ReturnType<typeof useFlowConfig>["config"] }) {
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const { settings } = useDefaultBrain();
  const line = useAnswerLine(config && settings ? flowBrain(config, settings) : null);
  return (
    <ChipButton tour="flow-brain" onClick={() => openSettingsTab("flow", { anchor: "set-flow-brain" })} tip="Who answers in Flow">
      {line.agent ? <AgentIcon id={line.agent} /> : <OpenLiveOrb size={12} />}
      <span className="min-w-0 truncate">{line.ready === false ? `${line.name} \u00b7 ${line.detail}` : line.name}</span>
      {line.ready !== null && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotTone(line.ready ? "success" : "arc"))} />}
    </ChipButton>
  );
}

function SessionRow({ session, delay, onOpen, selecting, picked, onToggle }: {
  session: FlowSessionSummary; delay: number; onOpen: () => void; selecting: boolean; picked: boolean; onToggle: () => void;
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
      <span className="shrink-0 text-caption tabular-nums text-faint" style={{ minWidth: `${clockWidth()}ch` }}>{clock(session.createdAt)}</span>
      {renaming
        ? <RenameInput initial={line} onDone={rename} className="flex-1 text-body" />
        : <Tooltip label={line} truncated className="min-w-0 flex-1"><span className="truncate text-body">&ldquo;{line}&rdquo;</span></Tooltip>}
      {session.state === "crash" && (
        <Badge tone="danger" className="shrink-0">Ended unexpectedly</Badge>
      )}
      {session.assets > 0 && (
        <Tooltip label={session.assets === 1 ? "One capture" : `${session.assets} captures`} className="shrink-0">
          <span className="flex items-center gap-1 text-caption tabular-nums text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden /> {session.assets}
          </span>
        </Tooltip>
      )}
      {Number.isFinite(ms) && ms > 0 && (
        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{duration(ms)}</span>
      )}
    </>
  );
  const cells = "flex min-h-12 min-w-0 flex-1 items-center gap-3.5 py-2 pl-3 text-left";

  // Clipped only while leaving, so the collapse hides the row but the open
  // menu is never cut off by its own row.
  return (
    <motion.div className={cn(!present && "overflow-hidden")}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { ...fade, delay: reduce ? 0 : delay } }}
      exit={{ opacity: 0, height: 0, transition: fade }}>
      {selecting ? (
        <Tooltip label={live && RUNNING_TIP} className="flex">
          <label className={cn(cells, "rounded-lg pr-3 transition hover:bg-foreground/[0.06]", picked && "bg-accent-soft", live ? "opacity-60" : "cursor-pointer")}>
            <Checkbox checked={picked} disabled={live} onChange={onToggle} />
            {body}
          </label>
        </Tooltip>
      ) : renaming ? (
        <div className={cn(cells, "pr-3")}>{body}</div>
      ) : (
        <div className="group flex min-w-0 items-center gap-1 rounded-lg pr-1.5 transition hover:bg-foreground/[0.06] has-[[aria-expanded=true]]:bg-foreground/[0.06]">
          <button type="button" onClick={onOpen} className={cn(cells, "rounded-lg active:scale-[0.99] motion-reduce:active:scale-100")}>{body}</button>
          <RowMenu live={live} onRename={() => setRenaming(true)} onDelete={() => deleteWithUndo([session.id], qc)} />
        </div>
      )}
    </motion.div>
  );
}

/** The widest this locale writes a time of day, in `ch`, so the quotes line up
 *  under each other whether the clock reads "22:22" or "10:22 PM". */
let clockCh = 0;
function clockWidth() {
  return (clockCh ||= clock(new Date(2000, 0, 1, 22, 22).toISOString()).length || 5);
}

/** Rename and Delete for one row. */
function RowMenu({ live, onRename, onDelete }: { live: boolean; onRename: () => void; onDelete: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(root, panel);

  return (
    <div ref={root} className="relative shrink-0">
      <Button variant="ghost" size="sm" icon onClick={toggle} aria-label="Session options" aria-haspopup="menu" aria-expanded={open}
        className={cn(!open && "opacity-60 group-hover:opacity-100 focus-visible:opacity-100")}>
        <MoreHorizontal />
      </Button>
      {mounted && (
        <div ref={panel} role="menu" aria-label="Session options"
          className={cn("absolute right-0 top-full z-overlay mt-1 flex w-max min-w-[9rem] origin-top-right flex-col", menuPanel)}>
          <Tooltip label={live && RUNNING_TIP} className="flex">
            <button type="button" role="menuitem" aria-disabled={live || undefined} onClick={() => { if (live) return; requestClose(); onRename(); }}
              className={cn(menuItem, "text-label font-medium aria-disabled:opacity-40 aria-disabled:hover:bg-transparent")}>
              Rename
            </button>
          </Tooltip>
          {/* Nothing goes until the Undo toast is gone, so no confirm, as in Chat and Dictate. */}
          <Tooltip label={live && RUNNING_TIP} className="flex">
            <button type="button" role="menuitem" aria-disabled={live || undefined} onClick={() => { if (live) return; requestClose(); onDelete(); }}
              className={cn(menuItem, "text-label font-medium text-destructive-text aria-disabled:opacity-40 aria-disabled:hover:bg-transparent")}>
              Delete
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
