"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Copy, CornerDownLeft, Search, Settings2, Trash2 } from "lucide-react";
import type { Dictation, FlowConfig } from "@openlive/flow-store";
import { Button, Chip, Input, Textarea, Tooltip, groupLabel } from "@/components/ui";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { ModeStart, ModeSteps, SwitchHole, modeCopy } from "@/components/flow/ModeSwitch";
import { PowerPill } from "@/components/flow/PowerPill";
import { ChipButton } from "@/components/flow/FlowHome";
import { AddonCard } from "@/components/flow/AddonCard";
import { deleteDictation, historyQuery, pendingDictationKey } from "@/lib/dictate/history";
import { QueryState, StatusDot } from "@/components/settings/common";
import { GrantPills, missingGrants } from "@/components/flow/GrantPills";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { flowBridge, valueOr, type FlowCapabilities } from "@/lib/flow/bridge";
import { keyListenerNote } from "@/lib/flow/failure";
import { flowOnboardingDue } from "@/lib/flow/onboarding";
import { keyName, liveKeys } from "@/lib/dictate/hotkey";
import { countWords } from "@/lib/dictate/cleanup";
import { COPIED, HISTORY_CHANNEL } from "@/lib/dictate/run";
import { desktopPlatform, isDesktop, isMacDesktop } from "@/lib/platform";
import { useOnboarding } from "@/lib/prefs";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { telemetry } from "@/lib/telemetry";
import { SkipSetup } from "@/components/SkipSetup";
import { toast } from "@/lib/toast";
import { usePendingDeletes } from "@/lib/deferredDelete";
import { cn } from "@/lib/cn";
import { SpotlightTour } from "@/components/SpotlightTour";

// Dictate's half of the window, for using it: whether it is on and works, how
// to start, and everything it typed. How it behaves is in Settings > Dictate,
// one press away, and nothing here is also there.

// Rows rendered at first and per "Show more": two thousand kept dictations stay quick to open and to search.
const PAGE = 100;
// The window it went to gets a moment to come forward before the text follows.
const FOCUS_MS = 250;

export function DictateHome() {
  const { config, save, error, refetch } = useFlowConfig();
  const { caps, refresh } = useFlowCapabilities();
  const settingsOpen = useUi((s) => s.settingsOpen);
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const onboarded = useOnboarding((s) => s.dictateOnboarded);

  // A grant given in System Settings announces nothing; coming back to the window re-reads it.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const own = config?.dictate;
  const on = !!own?.enabled;
  const key = config ? keyName(liveKeys(config.talk).dictate, desktopPlatform) : "the key";
  const flip = () => save({ dictate: { enabled: !on } });
  const firstRun = isDesktop && !!own && !onboarded;
  const { editReady } = useFlowConfig();
  // The tour points at a real row, so it waits for the first dictation.
  const dictations = useQuery({ ...historyQuery, retry: 1, enabled: !!config }).data?.items.length ?? 0;

  return (
    <div className="relative flex h-dvh flex-col">
      {/* Floats over the page, so what scrolls passes behind the mode switch. */}
      <header className={cn("absolute inset-x-0 top-0 flex h-14 items-center gap-3 pr-3", isMacDesktop ? "pl-traffic-lights" : "pl-4", isDesktop ? "app-drag" : "pointer-events-none")}>
        {isDesktop && <SwitchHole />}
      </header>

      {/* Anchored to the top like Flow's home, so the list changing height never moves the controls. */}
      <div className="openlive-scroll fade-top fade-under-switch flex min-h-0 flex-1 flex-col overflow-y-auto animate-fade-in">
        <div aria-hidden className="h-14 shrink-0" />
        <div className="mx-auto flex w-full max-w-[37.5rem] flex-1 flex-col gap-11 px-6 pb-8 pt-[clamp(1rem,6dvh,4rem)]">
          <section className="flex shrink-0 flex-col items-center gap-5 text-center">
            <OpenLiveOrb size={84} pulse={on} paused={settingsOpen || !on} />
            <div className="flex max-w-full flex-col items-center gap-2">
              <h1 className="text-display font-semibold tracking-tight">Dictate</h1>
              <p className="max-w-sm text-callout leading-relaxed text-muted-foreground">{modeCopy("dictate").tagline}</p>
            </div>

            {firstRun ? <FirstRun on={on} flip={flip} keyWords={key} caps={caps} refresh={refresh} /> : (
              <>
                <PowerPill name="Dictate" on={on} onFlip={flip} disabled={!config} />
                <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                  {on && <Status caps={caps} refresh={refresh} />}
                  <ChipButton onClick={() => openSettingsTab("dictate")} tip="Dictate settings" tour="dictate-settings" className="aspect-square justify-center px-0">
                    <Settings2 aria-hidden /><span className="sr-only">Dictate settings</span>
                  </ChipButton>
                </div>
                {own && <HowTo own={own} />}
              </>
            )}
            {!config && <QueryState loading={false} error={error || null} retrying={false} onRetry={refetch} what="read Dictate's settings" />}
            {config && error && <p role="alert" className="max-w-full break-words text-label text-destructive-text">{error}</p>}
            {caps?.addonError && <AddonCard error={caps.addonError} packaged={caps.packaged} user="dictate" onRetry={refresh} />}
          </section>

          {config && <History own={config.dictate} insertion={config.insertion} />}
        </div>
      </div>
      <SpotlightTour id="dictate" active={isDesktop && onboarded && on && dictations > 0} steps={[
        { target: "dictate-howto", title: "Change text by voice",
          body: editReady ? "Select text first, then say how to change it, like \u201cmake it shorter\u201d." : "Select text first, then say how to change it. That needs Dictate's AI, set up in Settings." },
        { target: "dictate-row-actions", title: "Put it back", body: "Copy it, or Insert again into the window it came from." },
        { target: "dictate-history", title: "Kept on this machine", body: "Settings decides how long dictations are kept, or keeps none at all." },
        { target: "dictate-settings", title: "Cleanup, polish and words", body: "Your dictionary, snippets and spoken commands live in Settings." },
      ]} />
    </div>
  );
}

/** Whether the key would work right now, and the fix right here when it would not. */
function Status({ caps, refresh }: { caps: FlowCapabilities | null; refresh: () => void }) {
  if (!caps || caps.addonError) return null;
  const note = keyListenerNote(caps, "dictate");
  const missing = missingGrants(caps);
  if (missing.length) return <GrantPills mode="dictate" missing={missing} refresh={refresh} />;
  if (note) return <StatusDot tone={caps.hookError ? "danger" : "arc"}>{note}</StatusDot>;
  return <StatusDot tone="success">Ready</StatusDot>;
}

/** How to use it, with the person's own keys. */
function HowTo({ own }: { own: FlowConfig["dictate"] }) {
  return (
    <div data-tour="dictate-howto" className="flex w-full flex-col items-center">
      <ModeSteps mode="dictate" on={own.enabled} />
    </div>
  );
}

/** The first visit: what Dictate is and turning it on, then one try in a box right here. Skippable; Done or Skip ends it for good. */
function FirstRun({ on, flip, keyWords, caps, refresh }: { on: boolean; flip: () => void; keyWords: string; caps: FlowCapabilities | null; refresh: () => void }) {
  const [card, setCard] = useState<1 | 2>(1);
  // The button pressed goes with the card it was on, so focus moves to the next card's heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const turned = useRef(false);
  const turn = (to: 1 | 2) => { turned.current = true; setCard(to); };
  useEffect(() => {
    if (!turned.current) return;
    turned.current = false;
    heading.current?.focus();
  }, [card]);
  const [tried, setTried] = useState("");
  // Skipped, the first run never comes back on its own, so Skip asks first, as Welcome's does.
  const [asking, setAsking] = useState(false);
  useEffect(() => { telemetry.track("onboarding_step", { step: "dictate_onboarding_shown" }); }, []);
  // Welcome's access step asked for these already; the second card still shows any that are missing.
  const welcomeAsked = useOnboarding((s) => !flowOnboardingDue(s.flowOnboarded));
  const done = (how: "dictate_onboarding_done" | "dictate_onboarding_skipped") => {
    telemetry.track("onboarding_step", { step: how });
    useOnboarding.setState({ dictateOnboarded: true });
  };
  const missing = missingGrants(caps);
  const head = (title: string) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 ref={heading} tabIndex={-1} className="text-title-sm font-semibold text-foreground">{title}</h2>
      <span className="text-caption tabular-nums text-muted-foreground">{card} of 2</span>
    </div>
  );

  return (
    <div role="group" aria-label="Get started with Dictate" className="flex w-full max-w-[30rem] flex-col gap-4 rounded-xl bg-card p-5 text-left shadow-card">
      {card === 1 ? (
        <>
          {head("Voice typing, no AI")}
          <ul className="flex flex-col gap-1.5 text-label leading-relaxed text-muted-strong">
            {modeCopy("dictate").body.split(/(?<=\.)\s+/).map((line) => <li key={line} className="break-words">{line}</li>)}
          </ul>
          <div className="flex flex-col items-start gap-3">
            <PowerPill name="Dictate" on={on} onFlip={flip} />
            {on && !welcomeAsked && <GrantPills mode="dictate" missing={missing} refresh={refresh} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SkipSetup asking={asking} onAsk={() => setAsking(true)} onKeep={() => setAsking(false)} onSkip={() => done("dictate_onboarding_skipped")} />
            <span className="flex-1" />
            <Tooltip label={!on && "Turn it on first"}>
              <Button variant="primary" disabled={!on} onClick={() => turn(2)}>Continue <ArrowRight aria-hidden /></Button>
            </Tooltip>
          </div>
        </>
      ) : (
        <>
          {head("Try it here")}
          <p className="break-words text-label leading-relaxed text-muted-strong"><ModeStart mode="dictate" on={on} /></p>
          {missing.length > 0 && <div className="flex flex-col items-start"><GrantPills mode="dictate" missing={missing} refresh={refresh} /></div>}
          <Textarea rows={3} value={tried} onChange={(e) => setTried(e.target.value)} aria-label="Try Dictate here" placeholder={`Click here, then double-tap ${keyWords} and talk`} />
          {tried.trim() && <StatusDot tone="success">That's all there is to it. It works the same in any app.</StatusDot>}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => turn(1)}><ArrowLeft aria-hidden /> Back</Button>
            <span className="flex-1" />
            <Button variant="primary" onClick={() => done("dictate_onboarding_done")}>Done</Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Every dictation kept, newest first, grouped by day. */
function History({ own, insertion }: { own: FlowConfig["dictate"]; insertion: FlowConfig["insertion"] }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...historyQuery, retry: 1, refetchOnWindowFocus: true });
  // A dictation into OpenLive's own window, the Try it here box too, leaves focus here, so focus alone never refetches.
  useEffect(() => {
    const ch = new BroadcastChannel(HISTORY_CHANNEL);
    ch.onmessage = () => void qc.invalidateQueries({ queryKey: historyQuery.queryKey });
    return () => ch.close();
  }, [qc]);
  const [filter, setFilter] = useState("");
  // A delete waiting out its Undo toast is hidden at once.
  const pending = usePendingDeletes((s) => s.keys);
  const items = useMemo(() => (data?.items ?? []).filter((d) => !pending.has(pendingDictationKey(d.id))), [data, pending]);
  // Lower-cased once per list, not once per keystroke.
  const hay = useMemo(() => items.map((d) => `${d.final} ${d.app ?? ""}`.toLowerCase()), [items]);
  const q = filter.trim().toLowerCase();
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [q]);
  // One pass to filter and group, newest day first as the list already is, up to `limit` rows. O(n).
  const { days, more } = useMemo(() => {
    const out: [string, Dictation[]][] = [];
    let shown = 0;
    for (let i = 0; i < items.length; i++) {
      if (q && !hay[i]!.includes(q)) continue;
      if (shown++ === limit) return { days: out, more: true };
      const d = items[i]!;
      const day = dayOf(d.at);
      if (out.at(-1)?.[0] === day) out.at(-1)![1].push(d);
      else out.push([day, [d]]);
    }
    return { days: out, more: false };
  }, [items, hay, q, limit]);

  return (
    <section className="flex min-h-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 pb-2">
        <h2 data-tour="dictate-history" className="min-w-0 flex-[1_1_8rem] truncate text-title-sm font-semibold">{q ? "Matches" : "History"}</h2>
        <Input type="search" icon={<Search />} value={filter} onChange={(e) => { if (!filter && e.target.value) featureUsed("n_dictate_history_search"); setFilter(e.target.value); }}
          placeholder="Search what you dictated" aria-label="Search what you dictated" data-history-search="dictate" className="min-w-[10rem] flex-[0_1_15rem]" />
      </div>
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} what="read Dictate's history" />
      {data && !items.length && (
        <Empty>{own.history === "off" ? "History is off, so dictations aren't kept." : "Nothing yet. What you dictate shows up here, kept on this machine."}</Empty>
      )}
      {q && items.length > 0 && !days.length && <Empty>Nothing matching &ldquo;{filter.trim()}&rdquo;.</Empty>}
      {days.map(([day, list], i) => (
        <div key={day} className="flex flex-col">
          <h3 className={cn("px-3 pb-1.5 pt-5", groupLabel)}>{day}</h3>
          {list.map((d, j) => <Row key={d.id} d={d} first={i === 0 && j === 0} insertion={insertion} onDelete={() => deleteDictation(qc, d.id)} />)}
        </div>
      ))}
      {more && <Button variant="ghost" size="sm" className="mt-1 self-start" onClick={() => setLimit((n) => n + PAGE)}>Show more</Button>}
    </section>
  );
}

function Row({ d, first, insertion, onDelete }: { d: Dictation; first: boolean; insertion: FlowConfig["insertion"]; onDelete: () => void }) {
  const copy = () => {
    featureUsed("n_dictate_history_copy");
    void navigator.clipboard.writeText(d.final).then(() => toast("Copied", "info")).catch(() => toast("Couldn't copy that."));
  };
  const words = countWords(d.final);
  // Back to the window it was said into, while that window is still open and has a text box in focus; else on the clipboard to paste.
  const again = async () => {
    featureUsed("n_dictate_insert_again");
    const api = flowBridge();
    let note = "That window's gone, so it's on the clipboard. Paste it where you want it.";
    if (api && d.windowId != null && (await api.device("control", { kind: "window", op: "activate", windowId: d.windowId })).ok) {
      await new Promise((r) => setTimeout(r, FOCUS_MS));
      if (valueOr(await api.focusEditable(), null) === false) note = COPIED;
      else {
        const session = valueOr(await api.insertBegin(insertion.method, insertion), -1);
        if (session >= 0 && (await api.insertPush(session, d.final)).ok && (await api.insertEnd(session)).ok) return;
      }
    }
    await navigator.clipboard.writeText(d.final).catch(() => {});
    toast(note, "info");
  };
  return (
    <div className="group flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 rounded-lg py-2 pl-3 pr-1.5 transition hover:bg-foreground/[0.06]">
      <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <Tooltip label={d.final} truncated className="flex min-w-0 max-w-full">
          <span className="line-clamp-3 whitespace-pre-line break-words text-body text-foreground">{d.final}</span>
        </Tooltip>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span className="tabular-nums">{timeOf(d.at)}</span>
          {d.app && <span className="min-w-0 break-words">{d.app}</span>}
          {d.command ? <Chip>Command</Chip> : <span>{words === 1 ? "1 word" : `${words} words`}</span>}
          {d.copied && <span>Copied, nowhere to type</span>}
        </span>
      </span>
      <span data-tour={first ? "dictate-row-actions" : undefined} className="ml-auto flex shrink-0 opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip label="Copy"><Button variant="ghost" size="sm" icon onClick={copy} aria-label="Copy"><Copy /></Button></Tooltip>
        {flowBridge() && <Tooltip label="Insert again"><Button variant="ghost" size="sm" icon onClick={() => void again()} aria-label="Insert again"><CornerDownLeft /></Button></Tooltip>}
        <Tooltip label="Delete"><Button variant="ghost" size="sm" icon onClick={onDelete} aria-label="Delete"><Trash2 /></Button></Tooltip>
      </span>
    </div>
  );
}

const dayOf = (at: number) => {
  const d = new Date(at), today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};
const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="m-auto max-w-[32rem] break-words px-6 py-10 text-center text-body leading-relaxed text-muted-strong">{children}</p>;
}
