"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Maximize2, Mic, MicOff, PhoneOff, Square, X } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { openliveBridge, type CallOrbState, type PanelCmd, type PanelPacket, type PanelStateSnapshot } from "@/lib/live/panelBridge";
import { flowBridge } from "@/lib/flow/bridge";
import { IDLE_FLOW, type FlowFailure, type FlowSnapshot } from "@/lib/flow/types";
import type { PendingPermission } from "@/lib/live/liveStore";
import { Orb } from "@/components/live/Orb";
import { pauseWaveOrbs, WAVE_ORB_RADIUS } from "@/lib/waveOrb";
import { cn } from "@/lib/cn";
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
/** The hover controls sit this far off the ball, inside its faint outer glow. */
const CONTROL_GAP = 10;

/** One solid surface for every panel in the window. */
const PANEL = "border border-border bg-surface shadow-[var(--shadow-card)]";
/** The one button shape here; the focus ring follows it (html.chromeless in globals.css). */
const PILL_BTN = "rounded-full px-4 py-2 text-label font-medium transition [-webkit-app-region:no-drag]";

/** Flow's phases onto the orb's states: confirming waits on the person's answer. */
const orbPhase = (p: FlowSnapshot["phase"]) => (p === "confirming" ? "listening" : p);

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
  /** The card outlives its question the same way, keeping its words on the way out. */
  const [cardUp, setCardUp] = useState(false);
  const lastAsk = useRef<{ permission: PendingPermission | null; failure: FlowFailure | null }>({ permission: null, failure: null });

  // Not over a turn in flight, where the caption is the thing to see; a failure
  // found as Flow opens is shown while it listens.
  const failure = shown && s.failure && (s.phase === "idle" || s.phase === "error" || s.phase === "listening") ? s.failure : null;
  // The two things worth interrupting someone for. Everything else is the orb.
  const asking = !!permission || !!failure;
  if (asking) lastAsk.current = { permission, failure };
  const ask = lastAsk.current;
  // Nothing stops to ask before a tool runs any more, so this caption is the
  // only thing that tells someone their machine is being driven, and by what.
  // Any other phase that says why it is waiting says so here too.
  const acting = s.phase === "acting" || s.phase === "confirming";
  const captioned = shown && !asking && (acting || !!s.detail);
  // Held through the strip's exit: blanking the words the moment the phase
  // changes empties the strip a beat before it has finished leaving.
  const said = captioned ? s.detail || "Working" : "";
  if (said) lastCaption.current = said;
  const caption = said || lastCaption.current;

  useEffect(() => { if (captioned) setStripUp(true); }, [captioned]);
  useEffect(() => { if (asking) setCardUp(true); }, [asking]);
  // Gone with the window rather than left sinking in it.
  useEffect(() => { if (!shown) { setStripUp(false); setCardUp(false); } }, [shown]);
  useRise(stripRef, captioned, stripUp, () => setStripUp(false), 0.2);
  useRise(cardRef, asking, cardUp, () => setCardUp(false), 0.25);

  // One caption replacing another is the same piece of work carrying on, so it
  // fades rather than cutting.
  useGSAP(() => {
    if (!captionRef.current || !caption || prefersReduced()) return;
    gsap.fromTo(captionRef.current, { autoAlpha: 0.2, y: 3 }, { autoAlpha: 1, y: 0, duration: DUR.fast, ease: EASE.out });
  }, { dependencies: [caption] });

  // The window is click-through, so hover cannot come from the DOM: the pointer
  // never enters anything. It comes from the moves the main process forwards,
  // tested against every `data-hit` element and nothing else, so the empty air
  // around them never blocks the dock or the app underneath.
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
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      clearTimeout(linger);
      api.interactive(false);
    };
  }, []);
  // A card or a strip can rise under a pointer that is not moving, and no move
  // arrives to make its buttons clickable.
  useEffect(() => retest.current(), [cardUp, stripUp, call]);

  // In the strip while Flow works, and on the card while a question waits on its answer.
  const stop = (
    <button type="button" onClick={() => cmd({ t: "flowStop" })} title="Stop" aria-label="Stop what Flow is doing"
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
                    it. */}
                {ask.permission.options.map((o) => (
                  <button key={o.id} onClick={() => cmd({ t: "permission", optionId: o.id })}
                    className={cn(PILL_BTN,
                      o.kind === "allow_always" ? "bg-destructive-fill text-white hover:opacity-90"
                        : o.kind === "allow_once" ? "bg-accent text-accent-foreground hover:opacity-90"
                          : "border border-border bg-card text-foreground hover:bg-foreground/10")}>
                    {o.label}
                  </button>
                ))}
                <span className="ml-auto whitespace-nowrap text-caption text-muted-strong">or say “yes” / “cancel”</span>
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

      {/* Drawn the whole time Flow is acting, not on hover: someone has to be
          able to see what it is doing without going to look for it. The window
          is click-through until the pointer arrives, which is what makes Stop
          pressable without the orb ever swallowing a click meant for the app
          underneath it. */}
      {stripUp && (
        <div ref={stripRef} data-hit className={cn("flex min-h-10 max-w-[min(24rem,100%)] shrink-0 items-center gap-2.5 rounded-[20px] py-1.5 pl-4 pr-1.5", PANEL)}>
          <span className="size-2 shrink-0 motion-safe:animate-pulse rounded-full bg-arc" aria-hidden />
          <span ref={captionRef} role="status" className="min-w-0 flex-1 break-words py-1 text-label font-medium" title={caption}>{caption}</span>
          {s.phase !== "listening" && stop}
        </div>
      )}

      {/* The controls flank the orb out of flow, so showing them never moves it
          out from under the pointer that asked for them. Each is a hit only while
          drawn, so the air beside the orb stays click-through. */}
      <div className="relative shrink-0">
        <Control label="Close Flow" shown={hovered} onClick={() => cmd({ t: "flowCancel" })}
          className="right-full origin-right" style={{ marginRight: CONTROL_GAP }}><X className="size-4" /></Control>
        <div data-hit>
          <Orb phase={orbPhase(s.phase)} getLevels={() => ({ mic: 0, agent: bands.current.agentLevel })} getBands={() => bands.current} size={ORB_SIZE} />
        </div>
        <Control label="Open OpenLive" shown={hovered} onClick={() => flowBridge()?.expand()}
          className="left-full origin-left" style={{ marginLeft: CONTROL_GAP }}><Maximize2 className="size-[15px]" /></Control>
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
      <button type="button" onClick={() => cmd("mute")} aria-pressed={call.muted} aria-label="Mute" title="Mute (M)"
        className={cn(btn, "ml-1", call.muted ? "bg-foreground/10 text-foreground" : "bg-card text-muted-strong hover:bg-foreground/10 hover:text-foreground")}>
        {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button type="button" onClick={() => cmd("expand")} aria-label="Open OpenLive" title="Open OpenLive"
        className={cn(btn, "bg-card text-muted-strong hover:bg-foreground/10 hover:text-foreground")}>
        <Maximize2 className="size-[15px]" />
      </button>
      <button type="button" onClick={() => cmd("end")} aria-label="End call" title={`End call (${isMac ? "⌘E" : "Ctrl+E"})`}
        className={cn(btn, "bg-destructive-fill text-white hover:opacity-90")}>
        <PhoneOff className="size-4" />
      </button>
    </div>
  );
}

function Control({ label, shown, onClick, className, style, children }: {
  label: string; shown: boolean; onClick: () => void; className: string; style: React.CSSProperties; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} data-hit={shown || undefined} style={style}
      className={cn("absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface text-muted-strong shadow-[var(--shadow-card)] transition duration-200 ease-out hover:bg-card hover:text-foreground [-webkit-app-region:no-drag]",
        shown ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0", className)}>
      {children}
    </button>
  );
}
