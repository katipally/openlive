"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Info, Loader2, Maximize2, Mic, MicOff, PhoneOff, Square, TextSelect, Undo2, X } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { openliveBridge, type CallOrbState, type PanelCmd, type PanelPacket, type PanelStateSnapshot } from "@/lib/live/panelBridge";
import { flowBridge } from "@/lib/flow/bridge";
import { IDLE_FLOW, type DictateSnapshot, type FlowFailure, type FlowSnapshot } from "@/lib/flow/types";
import type { PendingPermission } from "@/lib/live/liveStore";
import { Orb } from "@/components/live/Orb";
import { pauseWaveOrbs, WAVE_ORB_RADIUS, type WaveOrbState } from "@/lib/waveOrb";
import { cn } from "@/lib/cn";
import { Keycap, Tooltip } from "@/components/ui";
import { isMac } from "@/lib/platform";

// Flow's orb, in its own always-on-top window over the dock. It is voice, so it
// shows one thing: whether Flow is listening, thinking, speaking or doing
// something to the machine. Everything said is in the transcript, in the
// OpenLive window, and nothing is duplicated here. The orb only ever grows for
// something that needs the person: a question to answer, a reason Flow cannot
// work, or an action running on their machine while they watch.
//
// Everything it shows arrives over IPC from the owner renderer; every control
// sends a command back. It decides nothing.
//
// The same window also carries a live OpenLive call while the main window is
// minimised or hidden: the main process sends it, and a summoned Flow replaces
// it until Flow closes.

const NO_BANDS = [0, 0, 0, 0, 0];
/** What the orb reads until the owner's first bands packet of a session. */
const SILENT = { mic: NO_BANDS, agent: NO_BANDS, agentLevel: 0 };

/** The main process sizes the window once, for this card (FLOW_W in main.cjs),
 *  so nothing on screen ever resizes the window. */
const CARD_W = 392;
/** How long the hover controls outlast the pointer: long enough to cross from
 *  the orb to a button at an unhurried pace, short enough not to feel stuck. */
const CONTROLS_LINGER_MS = 600;
const ORB_SIZE = 64;
/** How far the orb's glow reaches past it. The window's bottom edge would cut
 *  it off, so the orb sits at least this far above that edge. */
const ORB_GLOW = (ORB_SIZE * (1 / WAVE_ORB_RADIUS - 1)) / 2;

/** The badges above the orb: the mic button's height, so swapping them never moves the orb. */
const BADGE = "flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-caption font-medium text-muted-strong shadow-card origin-bottom transition duration-fast ease-standard motion-reduce:transition-none";
const BADGE_ON = "scale-100 opacity-100";
const BADGE_OFF = "pointer-events-none translate-y-1 scale-90 opacity-0";

/** One solid surface for every panel in the window. */
const PANEL = "border border-border bg-surface shadow-card";
/** The one button shape here; the focus ring follows it (html.chromeless in globals.css).
 *  A long answer wraps inside its pill rather than pushing the card wider. */
const PILL_BTN = "max-w-full break-words rounded-full px-4 py-2 text-label font-medium transition [-webkit-app-region:no-drag]";

/** Flow's phases onto the orb's states: confirming waits on the person's answer.
 *  Dictate, while it has the orb, draws its own three. */
const orbPhase = (s: FlowSnapshot): WaveOrbState => {
  if (s.dictate) return s.dictate.phase === "idle" ? "dictateIdle" : s.dictate.phase === "listening" ? "dictateListening" : "dictateProcessing";
  return s.phase === "confirming" ? "listening" : s.phase;
};

export function FlowOrb() {
  const [s, setS] = useState<FlowSnapshot>(IDLE_FLOW);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [hovered, setHovered] = useState(false);
  const [call, setCall] = useState<CallOrbState | null>(null);
  /** Whether the window is on screen. Nothing rises while it is hidden, so a
   *  card from before a close can never be caught mid-exit by the next open. */
  const [shown, setShown] = useState(false);
  const bands = useRef<{ mic: number[]; agent: number[]; agentLevel: number }>(SILENT);
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cmd = (c: PanelCmd) => openliveBridge()?.panelCmd?.(c);

  useEffect(() => {
    openliveBridge()?.onPanelState?.((p: PanelPacket) => {
      if (p.k === "b") { bands.current = { mic: p.mic, agent: p.agent, agentLevel: p.agentLevel }; return; }
      if (p.k !== "s") return;
      const next = p.s as PanelStateSnapshot;
      setPermission(next.permission);
      if (next.flow) setS(next.flow);
    });
    // Its window hides as the call orb goes, with no `hiding` to say so; a summon
    // that follows is always `shown` after this.
    openliveBridge()?.onCallOrb?.((c) => { setCall(c); if (!c) { pauseWaveOrbs(true); setShown(false); bands.current = SILENT; } });
  }, []);

  const stripRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLSpanElement>(null);
  /** The caption strip outlives `captioned` by its own exit: unmounting on the
   *  event would cut the animation off at frame one, and the window would snap
   *  shut around a caption that was still on screen. */
  const [stripUp, setStripUp] = useState(false);
  const lastCaption = useRef("");
  const lastReplied = useRef(false);
  /** The card outlives its question the same way, keeping its words on the way out. */
  const [cardUp, setCardUp] = useState(false);
  const lastAsk = useRef<{ permission: PendingPermission | null; failure: FlowFailure | null }>({ permission: null, failure: null });

  // Not over a turn in flight, where the caption is the thing to see; a failure
  // found as Flow opens is shown while it listens.
  // Dictate needs no brain, so Flow's failures wait while it has the orb.
  const failure = shown && !s.dictate && s.failure && (s.phase === "idle" || s.phase === "error" || s.phase === "listening") ? s.failure : null;
  // The two things worth interrupting someone for. Everything else is the orb.
  const asking = !!permission || !!failure;
  if (asking) lastAsk.current = { permission, failure };
  const ask = lastAsk.current;
  // Nothing stops to ask before a tool runs any more, so this caption is the
  // only thing that tells someone their machine is being driven, and by what.
  // Any other phase that says why it is waiting says so here too.
  const acting = s.phase === "acting" || s.phase === "confirming";
  // A reply not said out loud is read here instead, until the next turn.
  const quietReply = !s.speaking && s.phase !== "error" ? s.reply : "";
  const captioned = shown && !asking && (acting || !!s.detail || !!quietReply);
  // Held through the strip's exit: blanking the words the moment the phase
  // changes empties the strip a beat before it has finished leaving.
  const said = !captioned ? "" : acting ? s.detail || "Working" : s.detail || quietReply;
  if (said) { lastCaption.current = said; lastReplied.current = said === quietReply; }
  const caption = said || lastCaption.current;
  const replied = lastReplied.current;

  useEffect(() => { if (captioned) setStripUp(true); }, [captioned]);
  // Dictate's strip rises and sinks like the caption, on its last words.
  const dictating = shown && !!s.dictate;
  const dictateRef = useRef<HTMLDivElement>(null);
  const [dictateUp, setDictateUp] = useState(false);
  const lastDictate = useRef<DictateSnapshot | null>(null);
  if (s.dictate) lastDictate.current = s.dictate;
  useEffect(() => { if (dictating) setDictateUp(true); }, [dictating]);
  useRise(dictateRef, dictating, dictateUp, () => setDictateUp(false), 0.2);
  // What sits above the orb: how Flow or Dictate listens right now. Dictate's
  // is also its off switch. Flow's makes way for the mic button on hover, and
  // hands-free it shows only while Flow is listening rather than answering.
  // A badge leaving keeps its words while it fades.
  const ptt = s.talk.mode === "ptt";
  const waiting = ptt && !s.talk.holding;
  const badge = !shown ? null
    : s.dictate ? "dictate"
    : !hovered && (ptt ? s.phase !== "error" : s.phase === "listening") ? "flow" : null;
  // A filled, breathing dot while it hears you; a ring while it waits for the key.
  const badgeWords = (): React.ReactNode => {
    if (s.dictate?.editing) return <><TextSelect aria-hidden className="size-3.5 shrink-0" /> Editing selection</>;
    if (waiting) return (
      <>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full ring-1 ring-current" />
        Hold {s.talk.keys.map((k) => <Keycap key={k} className="px-1 py-0 text-micro">{k}</Keycap>)} to talk
      </>
    );
    return <><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse" /> {s.dictate && !ptt ? "Hands-free" : "Listening"}</>;
  };
  const lastBadge = useRef<{ kind: "flow" | "dictate"; words: React.ReactNode } | null>(null);
  if (badge) lastBadge.current = { kind: badge, words: badgeWords() };
  const badgeShows = (kind: "flow" | "dictate") => (lastBadge.current?.kind === kind ? lastBadge.current.words : null);
  useEffect(() => { if (asking) setCardUp(true); }, [asking]);
  // Gone with the window rather than left sinking in it.
  useEffect(() => { if (!shown) { setStripUp(false); setCardUp(false); setDictateUp(false); } }, [shown]);
  useRise(stripRef, captioned, stripUp, () => setStripUp(false), 0.2);
  useRise(cardRef, asking, cardUp, () => setCardUp(false), 0.25);

  // One caption replacing another is the same piece of work carrying on, so it
  // fades rather than cutting.
  // A reply grows a few words at a time: it fades in once, then keeps its
  // newest line in view.
  useGSAP(() => {
    if (!captionRef.current || !caption || prefersReduced()) return;
    gsap.fromTo(captionRef.current, { autoAlpha: 0.2, y: 3 }, { autoAlpha: 1, y: 0, duration: DUR.fast, ease: EASE.out });
  }, { dependencies: [replied ? "reply" : caption] });
  useEffect(() => { if (replied && captionRef.current) captionRef.current.scrollTop = captionRef.current.scrollHeight; }, [replied, caption]);

  // The window is click-through, so hover cannot come from the DOM: the pointer
  // never enters anything. It comes from the moves the main process forwards
  // (on X11, the cursor it polls), tested against every `data-hit` element and
  // nothing else, so the empty air around them never blocks the dock or the
  // app underneath.
  const retest = useRef(() => {});
  useEffect(() => {
    const api = flowBridge();
    const root = rootRef.current;
    if (!api || !root) return;
    let inside = false;
    let at: { x: number; y: number } | null = null;
    let linger: ReturnType<typeof setTimeout> | undefined;
    const test = () => {
      const p = at;
      const next = !!p && Array.from(root.querySelectorAll("[data-hit]")).some((el) => {
        const r = el.getBoundingClientRect();
        return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      });
      if (next === inside) return;
      inside = next;
      api.interactive(next);
      clearTimeout(linger);
      // Clicks pass through the moment the pointer is off, but the controls stay
      // up (and hit-testable) a beat longer: the path from the orb to them
      // crosses a gap, and hiding on the first off-target move made them
      // impossible to reach.
      if (next) setHovered(true);
      else linger = setTimeout(() => setHovered(false), CONTROLS_LINGER_MS);
    };
    retest.current = test;
    const onMove = (e: MouseEvent) => { at = { x: e.clientX, y: e.clientY }; test(); };
    // The pointer can leave the window between two moves, and once it is gone no
    // further move arrives to close the controls.
    const onLeave = () => { at = null; test(); };
    // Being shown puts the window back to click-through underneath us. Closing
    // Flow with the pointer still on the orb would otherwise leave `inside` set,
    // and the next move over the orb would match it and ask for nothing — so the
    // controls would draw and do nothing when clicked. A summon mid-exit lands
    // here too, and overwriting the exit keeps it from ever answering `hidden`.
    api.onShown?.(() => {
      pauseWaveOrbs(false);
      setShown(true);
      inside = false; at = null; clearTimeout(linger); setHovered(false);
      gsap.to(root, { autoAlpha: 1, y: 0, duration: prefersReduced() ? 0 : 0.2, ease: EASE.out, overwrite: true });
    });
    // The window hides only once this answers, which leaves the orb faded out
    // for the next open to rise from.
    api.onHiding?.(() => {
      gsap.to(root, { autoAlpha: 0, y: 8, duration: prefersReduced() ? 0 : 0.16, ease: EASE.out, overwrite: true, onComplete: () => { pauseWaveOrbs(true); setShown(false); bands.current = SILENT; api.hidden?.(); } });
    });
    // Background throttling is off here, so a hidden window would keep drawing
    // the orb: it holds still until shown. The window may have been shown before
    // `onShown` was listening, so it asks.
    pauseWaveOrbs(true);
    void api.visible?.().then((v) => { if (v) { pauseWaveOrbs(false); setShown(true); } });
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    const offPointer = api.onPointer?.((p) => { at = p; test(); });
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      offPointer?.();
      clearTimeout(linger);
      api.interactive(false);
    };
  }, []);
  // A card or a strip can rise under a pointer that is not moving, and no move
  // arrives to make its buttons clickable.
  useEffect(() => retest.current(), [cardUp, stripUp, call, s.aside, badge, dictateUp, s.dictate?.undo]);

  // In the strip while Flow works, and on the card while a question waits on its answer.
  const stop = (
    <button type="button" onClick={() => cmd({ t: "flowStop" })} aria-label="Stop what Flow is doing"
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-caption font-medium text-muted-strong transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]">
      <Square className="size-3 fill-current" aria-hidden /> Stop
    </button>
  );

  // Same root element either way, so the hit testing wired to it carries over.
  if (call) {
    return (
      <div ref={rootRef} className="fixed inset-0 flex flex-col items-center justify-end gap-2.5 p-3">
        <CallOrb call={call} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="fixed inset-0 flex flex-col items-center justify-end gap-2.5 p-3" style={{ paddingBottom: Math.max(12, ORB_GLOW) }}>
      {/* Always mounted, so a card appearing is a change a screen reader hears.
          Only an approval interrupts; a failure waits its turn. */}
      <span className="sr-only" aria-live="assertive">{permission?.question ?? ""}</span>
      <span className="sr-only" aria-live="polite">{failure ? `${failure.title}. ${failure.detail}` : ""}</span>
      {/* Rises out of the orb; past the window's height it scrolls, never clips. */}
      {cardUp && (
        <div ref={cardRef} data-hit style={{ width: CARD_W }}
          className={cn("flex min-h-0 max-w-full origin-bottom flex-col gap-3.5 overflow-y-auto overscroll-contain rounded-[20px] p-4", PANEL)}>
          {ask.permission ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="break-words text-body font-medium">{ask.permission.question}</span>
                {s.detail && <span className="break-words text-label text-muted-strong" role="status">{s.detail}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Red is for what a yes cannot be taken back from. Flow's own
                    questions are ordinary ones — "may I act on this machine" in
                    danger red reads as a warning about itself — so the colour
                    follows the agent's own kind, and only an always-allow earns
                    it, as an outline: the filled, primary pill is the safe yes. */}
                {ask.permission.options.map((o) => (
                  <button key={o.id} onClick={() => cmd({ t: "permission", optionId: o.id })}
                    className={cn(PILL_BTN,
                      o.kind === "allow_always" ? "border border-destructive-text bg-card text-destructive-text hover:bg-destructive-text/10"
                        : o.kind === "allow_once" ? "bg-accent text-accent-foreground hover:opacity-90"
                          : "border border-border bg-card text-foreground hover:bg-foreground/10")}>
                    {o.label}
                  </button>
                ))}
                <span className="ml-auto text-caption text-muted-strong">or say “yes” or “cancel”</span>
                {stop}
              </div>
            </>
          ) : ask.failure && (
            <>
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-danger" aria-hidden />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="break-words text-body font-medium">{ask.failure.title}</span>
                  <span className="break-words text-label text-muted-strong">{ask.failure.detail}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {ask.failure.actionLabel && (
                  <button onClick={() => cmd({ t: "flowFix", code: ask.failure!.code })}
                    className={cn(PILL_BTN, "bg-accent text-accent-foreground hover:opacity-90")}>
                    {ask.failure.actionLabel}
                  </button>
                )}
                <button onClick={() => cmd({ t: "flowCancel" })}
                  className={cn(PILL_BTN, "border border-border bg-card text-foreground hover:bg-foreground/10")}>
                  Close Flow
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* A sentence the side talk check dropped, dashed like the transcript's,
          until the next turn. Sending it makes it that turn. */}
      {shown && s.aside && !asking && !captioned && (
        <div data-hit className={cn("flex max-w-[min(24rem,100%)] shrink-0 items-center gap-2.5 rounded-[20px] border-dashed py-1.5 pl-4 pr-1.5", PANEL)}>
          <Tooltip label={s.aside} truncated className="min-w-0 flex-1">
            <span role="status" className="line-clamp-2 break-words text-label text-muted-strong">Taken as side talk, not sent: “{s.aside}”</span>
          </Tooltip>
          <button type="button" onClick={() => cmd({ t: "flowSendAside" })}
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-caption font-medium text-foreground transition hover:bg-foreground/10 [-webkit-app-region:no-drag]">
            Send it
          </button>
        </div>
      )}

      {/* Dictate's words as they are heard, one line that drops its oldest
          words off the start, then the same words while they are worked on. */}
      {dictateUp && lastDictate.current && (
        <div ref={dictateRef} className="flex max-w-full shrink-0 justify-center">
          <DictateStrip d={lastDictate.current} waiting={waiting ? "Ready" : ""} onUndo={() => cmd({ t: "dictateUndo" })} />
        </div>
      )}

      {/* Drawn the whole time Flow is acting, not on hover: someone has to be
          able to see what it is doing without going to look for it. The window
          is click-through until the pointer arrives, which is what makes Stop
          pressable without the orb ever swallowing a click meant for the app
          underneath it. */}
      {stripUp && !s.dictate && (
        <div ref={stripRef} data-hit className={cn("flex min-h-10 max-w-[min(24rem,100%)] shrink-0 items-center gap-2.5 rounded-[20px] py-1.5 pl-4 pr-1.5", PANEL)}>
          <span className="size-2 shrink-0 motion-safe:animate-pulse rounded-full bg-arc" aria-hidden />
          {/* One line: a caption longer than the strip drops its oldest words
              off the start, so the newest stay in view. A reply is read, so it
              wraps, and scrolls once it outgrows a few lines. */}
          {replied
            ? <span ref={captionRef} role="status" className="openlive-scroll max-h-[min(10rem,30vh)] min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap py-1 text-label font-medium [overflow-wrap:anywhere]">{caption}</span>
            : (
              <span className="flex min-w-0 flex-1 justify-end overflow-hidden whitespace-nowrap py-1">
                <span ref={captionRef} role="status" className="shrink-0 grow text-label font-medium">{caption}</span>
              </span>
            )}
          {s.phase !== "listening" && stop}
        </div>
      )}

      {/* The controls keep their places whether drawn or not, so showing them
          never moves the orb out from under the pointer that asked for them.
          Each is a hit only while drawn, so the air around the orb stays
          click-through. */}
      {/* One place above the orb for the mic button or how Flow or Dictate is
          listening. All three share the cell and cross-fade, so one becomes the
          next instead of popping, and the orb never moves. */}
      <div className="grid shrink-0 place-items-center [&>*]:[grid-area:1/1]">
        <Control label="Start dictation" shown={hovered && !badge} onClick={() => cmd({ t: "dictateToggle" })} side="top">
          <Mic className="size-4" />
        </Control>
        <span role="status" aria-hidden={badge !== "flow"} className={cn(BADGE, badge === "flow" ? BADGE_ON : BADGE_OFF)}>
          {badgeShows("flow")}
        </span>
        <button type="button" data-hit={badge === "dictate" || undefined} tabIndex={badge === "dictate" ? 0 : -1} aria-hidden={badge !== "dictate"}
          onClick={() => cmd({ t: "dictateToggle" })} aria-label="Stop dictating"
          className={cn(BADGE, "gap-2 pr-2.5 hover:bg-card hover:text-foreground [-webkit-app-region:no-drag]", badge === "dictate" ? BADGE_ON : BADGE_OFF)}>
          {badgeShows("dictate")} <Square className="size-2.5 fill-current" aria-hidden />
        </button>
      </div>
      <div className="relative shrink-0">
        <Control label="Close Flow" shown={hovered} onClick={() => cmd({ t: "flowCancel" })} side="left"><X className="size-4" /></Control>
        {/* flow-root keeps the canvas's negative margins (its glow) inside this box,
            which would otherwise be the glow's height: the ring an oval, the hit too tall. */}
        <div data-hit className="relative flow-root">
          <Orb phase={orbPhase(s)} getLevels={() => ({ mic: 0, agent: bands.current.agentLevel })} getBands={() => bands.current} size={ORB_SIZE} />
        </div>
        <Control label="Open OpenLive" shown={hovered} onClick={() => flowBridge()?.expand()} side="right"><Maximize2 className="size-4" /></Control>
      </div>
    </div>
  );
}

/** Rises out of the orb while `on` and sinks back into it before `onGone`
 *  unmounts it. `up` is the mount, so the entrance runs once the node exists.
 *  Overwriting means turning back mid-exit cancels the unmount, not races it. */
function useRise(ref: React.RefObject<HTMLElement | null>, on: boolean, up: boolean, onGone: () => void, duration: number) {
  useGSAP(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced()) { gsap.set(el, { autoAlpha: on ? 1 : 0, overwrite: true }); if (!on) onGone(); return; }
    const sunk = { autoAlpha: 0, y: 10, scale: 0.96 };
    if (on) gsap.fromTo(el, sunk, { autoAlpha: 1, y: 0, scale: 1, duration, ease: EASE.out, overwrite: true });
    else gsap.to(el, { ...sunk, duration, ease: EASE.out, overwrite: true, onComplete: onGone });
  }, { dependencies: [on, up] });
}

/** The live call, while its window is out of sight. Commands go to the main
 *  process: Open is its own, mute and end it passes to the call. */
function CallOrb({ call }: { call: CallOrbState }) {
  const cmd = (t: "mute" | "end" | "expand") => openliveBridge()?.callCmd?.({ t });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - call.startedAt) / 1000));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  const elapsed = `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
  const btn = "grid size-9 shrink-0 place-items-center rounded-full transition [-webkit-app-region:no-drag]";
  return (
    <div data-hit role="group" aria-label="OpenLive call"
      className={cn("flex max-w-full shrink-0 items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5", PANEL)}>
      <span className={cn("size-2 shrink-0 rounded-full", call.muted ? "bg-faint" : "bg-success motion-safe:animate-pulse")} aria-hidden />
      <span className="min-w-0 truncate text-label font-medium">{call.muted ? "Muted" : "In call"}</span>
      <span className="shrink-0 text-label tabular-nums text-muted-strong" aria-label={`Call time ${elapsed}`}>{elapsed}</span>
      <Tooltip label="Mute" keys="M" className="ml-1 shrink-0">
        <button type="button" onClick={() => cmd("mute")} aria-pressed={call.muted} aria-label="Mute"
          className={cn(btn, call.muted ? "bg-foreground/10 text-foreground" : "bg-card text-muted-strong hover:bg-foreground/10 hover:text-foreground")}>
          {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>
      </Tooltip>
      <Tooltip label="Open OpenLive" className="shrink-0">
        <button type="button" onClick={() => cmd("expand")} aria-label="Open OpenLive"
          className={cn(btn, "bg-card text-muted-strong hover:bg-foreground/10 hover:text-foreground")}>
          <Maximize2 className="size-[15px]" />
        </button>
      </Tooltip>
      <Tooltip label="End call" keys={isMac ? "⌘E" : "Ctrl+E"} className="shrink-0">
        <button type="button" onClick={() => cmd("end")} aria-label="End call"
          className={cn(btn, "bg-destructive-fill text-white hover:opacity-90")}>
          <PhoneOff className="size-4" />
        </button>
      </Tooltip>
    </div>
  );
}

/** Where each control sits. The offset goes on the tooltip's anchor, never as
 *  a margin on the button inside it: the anchor would grow by the margin and
 *  lie over a neighbour, taking its clicks and showing the wrong tooltip. The
 *  gap leaves each inside the orb's faint outer glow. The top one is in the
 *  column's flow, its slot kept while hidden. */
const CONTROL_PLACE = {
  left: "absolute right-full top-1/2 mr-2.5 -translate-y-1/2",
  right: "absolute left-full top-1/2 ml-2.5 -translate-y-1/2",
  top: "shrink-0",
};
const CONTROL_GROW = { left: "origin-right", right: "origin-left", top: "origin-bottom" };

/** A round button around the orb, growing out of its edge on hover, or on
 *  keyboard focus. */
function Control({ label, shown, onClick, side, children }: {
  label: string; shown: boolean; onClick: () => void; side: keyof typeof CONTROL_PLACE; children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} className={cn(CONTROL_PLACE[side], !shown && "pointer-events-none")}>
      <button type="button" onClick={onClick} aria-label={label} data-hit={shown || undefined}
        className={cn("grid size-8 place-items-center rounded-full border border-border bg-surface text-muted-strong shadow-card transition duration-fast ease-standard hover:border-border-heavy hover:bg-card hover:text-foreground active:scale-90 [-webkit-app-region:no-drag]",
          CONTROL_GROW[side], shown ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0 focus-visible:scale-100 focus-visible:opacity-100")}>
        {children}
      </button>
    </Tooltip>
  );
}

/** Processing is often over in a few hundred ms: the strip shows it at least
 *  this long so it reads as work, not a flicker. The words are typed meanwhile;
 *  only the strip waits. */
const PROCESSING_MIN_MS = 500;

/** `d`, except that leaving processing waits out PROCESSING_MIN_MS. */
function useHeldProcessing(d: DictateSnapshot): DictateSnapshot {
  const [held, setHeld] = useState(d);
  const since = useRef(0);
  const holding = useRef(false);
  useEffect(() => {
    const wait = holding.current && d.phase !== "processing" ? PROCESSING_MIN_MS - (performance.now() - since.current) : 0;
    const show = () => {
      if (d.phase === "processing" && !holding.current) since.current = performance.now();
      holding.current = d.phase === "processing";
      setHeld(d);
    };
    if (wait <= 0) return show();
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
  }, [d]);
  return held;
}

/** Dictate under the orb: what it hears, the words while they are worked on, then
 *  what landed. `waiting`: what to say between holds in push to talk; the
 *  badge above already names the key. */
function DictateStrip({ d: live, waiting, onUndo }: { d: DictateSnapshot; waiting: string; onUndo: () => void }) {
  const d = useHeldProcessing(live);
  const working = d.phase === "processing";
  const landed = !working && !d.note && d.inserted > 0;
  const label = working && (d.polishing ? "Polishing" : d.editing ? "Editing" : !d.partial && "Cleaning up");
  const said = d.note || label || (landed ? `${d.inserted} ${d.inserted === 1 ? "word" : "words"}` : d.partial || (!d.ready ? "Getting ready" : d.phase === "idle" && waiting ? waiting : "Listening"));
  // Words still coming, or being worked on, drop their oldest off the start;
  // a status or a note is read whole, so it wraps instead.
  const flowing = said === d.partial;
  const kind = working ? "working" : landed ? "landed" : d.note ? "note" : "live";
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  // One state giving way to the next eases the strip to its new width and fades
  // the new words in, instead of the strip snapping around them.
  useLayoutEffect(() => {
    const box = boxRef.current, body = bodyRef.current;
    if (!box || !body) return;
    const from = width.current, to = box.offsetWidth;
    width.current = to;
    if (!from || prefersReduced()) return;
    if (from !== to) gsap.fromTo(box, { width: from }, { width: to, duration: DUR.fast, ease: EASE.out, overwrite: true, clearProps: "width" });
    gsap.fromTo(body, { autoAlpha: 0.15, y: 3 }, { autoAlpha: 1, y: 0, duration: DUR.fast, ease: EASE.out, overwrite: true });
  }, [kind]);
  useLayoutEffect(() => { if (boxRef.current && !gsap.isTweening(boxRef.current)) width.current = boxRef.current.offsetWidth; });
  return (
    <div ref={boxRef} data-hit={d.undo || undefined}
      className={cn("flex min-h-10 max-w-[min(24rem,100%)] shrink-0 overflow-hidden rounded-[20px] py-1.5 pl-4", d.undo ? "pr-1.5" : "pr-4", PANEL)}>
      <div ref={bodyRef} className="flex min-w-0 flex-1 items-center gap-2.5">
        {working ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-strong motion-reduce:animate-none" aria-hidden />
          : landed ? <Check className="size-3.5 shrink-0 text-muted-strong" aria-hidden />
          : d.note && <Info className="size-3.5 shrink-0 text-muted-strong" aria-hidden />}
        {flowing
          ? (
            <span className="flex min-w-0 flex-1 justify-end overflow-hidden whitespace-nowrap py-1">
              <span role="status" className={cn("shrink-0 grow text-label font-medium", working && "dictate-shimmer")}>{said}</span>
            </span>
          )
          : <span role="status" className={cn("min-w-0 flex-1 py-1 text-label font-medium [overflow-wrap:anywhere]", working ? "dictate-shimmer" : !d.note && !landed && "text-muted-strong")}>{said}</span>}
        {d.undo && (
          <button type="button" onClick={onUndo}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-caption font-medium text-muted-strong transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]">
            <Undo2 className="size-3" aria-hidden /> Undo
          </button>
        )}
      </div>
    </div>
  );
}
