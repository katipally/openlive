"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useUi } from "@/lib/uiStore";
import { useOnboarding } from "@/lib/prefs";
import { tourClosed, tourRun, type TourExit, type TourId } from "@/lib/featureUse";
import { Button } from "@/components/ui";
import { useFocusTrap } from "@/lib/useFocusTrap";

// Reusable first-visit SPOTLIGHT tour: dims the page with a cutout + accent ring
// around the ACTUAL control (found by [data-tour="…"]) and points an arrowed
// tooltip at it. Each surface mounts its own <SpotlightTour id steps/> — the
// tour runs ONCE per id (remembered in ui.json), is fully skippable (Skip/Escape/×, confirmed, for good; a click
// elsewhere ends it until next time), and follows the target on resize. Pure CSS motion (fade/slide keyframes + hole
// transitions), no imperative animation against elements that may not exist,
// which is what made the previous GSAP version spam "target not found".
//
// The rule every tour keeps: one per surface, at most MAX_TOUR_STEPS steps, each
// on a real control; never over Welcome, the privacy notice, a mode's first run or
// Settings; and a step whose concept a first run showed this launch is dropped.
export interface TourStep {
  target: string; title: string; body: string;
  /** Dropped when a first run already showed it this launch. */
  concept?: TourConcept;
}
const MAX_TOUR_STEPS = 4;

/** What a first run showed: Welcome the modes and who answers, Flow's setup its switch. */
export type TourConcept = "modes" | "whoAnswers" | "flowPower";
/** This launch only: the concepts first runs covered, and whether one of the app's
 *  first-run screens (the privacy notice, Welcome) is up, which every tour waits out. */
export const useTourGate = create<{ covered: ReadonlySet<TourConcept>; firstRun: boolean }>(() => ({ covered: new Set(), firstRun: false }));
export const coverConcepts = (...c: TourConcept[]): void => useTourGate.setState((s) => ({ covered: new Set([...s.covered, ...c]) }));

export const tourSeen = (id: string): boolean => useOnboarding.getState().tours.includes(id);
const markSeen = (id: string) => { if (!tourSeen(id)) useOnboarding.setState((s) => ({ tours: [...s.tours, id] })); };
/** Forgets every tour, so each plays again the next time its screen shows. */
export function resetTours(): void { useOnboarding.setState({ tours: [] }); }

export function SpotlightTour({ id, steps, active = true }: { id: TourId; steps: TourStep[]; active?: boolean }) {
  const [show, setShow] = useState(false);
  // Settings covers every other surface, so only its own tour may run over it;
  // the rest wait and pick up again once it closes.
  const coveredBySettings = useUi((s) => s.settingsOpen) && id !== "settings";
  const firstRun = useTourGate((s) => s.firstRun);
  const covered = useTourGate((s) => s.covered);
  const shown = steps.filter((s) => !s.concept || !covered.has(s.concept));
  if (process.env.NODE_ENV !== "production" && steps.length > MAX_TOUR_STEPS) console.error(`The ${id} tour has ${steps.length} steps; a tour has at most ${MAX_TOUR_STEPS}.`);
  const live = active && !coveredBySettings && !firstRun && shown.length > 0;
  // A click outside ends the tour for now, not for good: only Done or a confirmed Skip is.
  const forNow = useRef(false);
  const run = useMemo(() => tourRun((exit, reached) => {
    if (!forNow.current) markSeen(id);
    forNow.current = false;
    tourClosed(id, exit, reached);
  }), [id]);
  // Defer the start slightly so the surface's own entrance animation finishes
  // and the anchors are where they'll stay.
  useEffect(() => {
    if (!live || tourSeen(id)) return;
    const t = setTimeout(() => { run.begin(); setShow(true); }, 650);
    return () => clearTimeout(t);
  }, [id, live, run]);
  // The whole screen going away takes the tour with it, and that is an exit too.
  useEffect(() => () => run.end("left"), [run]);
  if (!show || !live) return null;
  return <Tour steps={shown} run={run} onClose={(exit, again) => { forNow.current = !!again; run.end(exit); setShow(false); }} />;
}

const CARD_MAX_W = 330;

// Inner component mounts ONLY while the tour is live, so every hook and DOM
// measurement runs against elements that actually exist.
function Tour({ steps, run, onClose }: { steps: TourStep[]; run: ReturnType<typeof tourRun>; onClose: (exit: TourExit, again?: boolean) => void }) {
  const [step, setStep] = useState(0);
  // Skip ends the tour for good, so it asks first, as Welcome's does.
  const [asking, setAsking] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(190); // measured after render so vertical clamping is exact
  // Callers pass fresh steps/onClose each render; the poll below keys on the
  // target alone so a parent re-render does not restart it.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; run.reach(step + 1); });
  const target = steps[step]!.target;

  // Poll the anchor (rAF-throttled) so the spotlight FOLLOWS layout changes, and —
  // critically — CLOSE the tour if the target disappears (the user navigated away or
  // opened Settings over the surface). Without this a stale rect stranded the bubble
  // on screen. Only setRect on an actual change so we don't re-render every frame.
  useEffect(() => {
    const sel = `[data-tour="${target}"]`;
    let raf = 0;
    let missingSince = 0;
    let prev = "";
    const tick = (t: number) => {
      const el = document.querySelector(sel);
      if (el) {
        missingSince = 0;
        const r = el.getBoundingClientRect();
        const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
        if (key !== prev) { prev = key; setRect(r); }
      } else {
        if (!missingSince) missingSince = t;
        else if (t - missingSince > 400) { onCloseRef.current("left"); return; } // anchor gone for good → don't strand
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const close = useCallback((exit: TourExit) => { setLeaving(true); setTimeout(() => onCloseRef.current(exit), 180); }, []);
  const skip = useCallback(() => setAsking(true), []);
  // Focus goes back to Next, not to wherever the gone question leaves it.
  const keepGoing = () => { setAsking(false); requestAnimationFrame(() => nextRef.current?.focus()); };

  // The dim layer lets clicks through, so a click outside the card both ends the
  // tour and lands on what it hit. It ends at once, before the click arrives, so
  // the focus the tour hands back cannot steal it from whatever that click opens.
  // Nothing was confirmed, so the tour shows again the next time.
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!cardRef.current?.contains(e.target as Node)) onCloseRef.current("left", true); };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Active once measured: the tour renders nothing until its target has a rect.
  useFocusTrap(rootRef, !!rect);
  // Escape is the tour's before anything under it: Settings' own trap would
  // otherwise close Settings first, taking its tour along unasked.
  const onEscape = useRef(() => {});
  onEscape.current = () => (asking ? keepGoing() : skip());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Measure the real card height so vertical clamping keeps EVERY row (incl. the
  // Done button) inside the viewport — a fixed estimate pushed it off-screen for
  // tall targets.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  if (!rect) return null;
  const s = steps[step]!;
  const last = step === steps.length - 1;

  const pad = 10;
  const hole = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const vw = window.innerWidth, vh = window.innerHeight, gap = 14, margin = 16;
  // Never wider than the window leaves room for.
  const CARD_W = Math.min(CARD_MAX_W, vw - margin * 2);
  const cx = hole.left + hole.width / 2, cy = hole.top + hole.height / 2;

  // Pick the side with room — below → above → right → left. A full-height target
  // (the setup panel) has no room above/below, so the card goes BESIDE it instead of
  // off the top of the screen.
  const fitsV = (edge: number) => edge >= cardH + gap + margin;
  const fitsH = (edge: number) => edge >= CARD_W + gap + margin;
  const place =
    fitsV(vh - (hole.top + hole.height)) ? "below" :
    fitsV(hole.top) ? "above" :
    fitsH(vw - (hole.left + hole.width)) ? "right" :
    fitsH(hole.left) ? "left" : "below";

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let top: number, left: number;
  if (place === "below" || place === "above") {
    top = place === "below" ? hole.top + hole.height + gap : hole.top - cardH - gap;
    left = cx - CARD_W / 2;
  } else {
    left = place === "right" ? hole.left + hole.width + gap : hole.left - CARD_W - gap;
    top = cy - cardH / 2;
  }
  left = clamp(left, margin, vw - CARD_W - margin);
  top = clamp(top, margin, vh - cardH - margin);

  // Arrow points back at the target from the card edge nearest it. Hidden when the
  // clamp pulled the card away from that edge (the arrow would point at nothing).
  const vertical = place === "below" || place === "above";
  const arrowPos = vertical ? clamp(cx - left, 20, CARD_W - 20) : clamp(cy - top, 20, cardH - 20);
  const arrowOnCard = vertical
    ? (place === "below" ? Math.abs(top - (hole.top + hole.height + gap)) < 2 : Math.abs(top - (hole.top - cardH - gap)) < 2)
    : (place === "right" ? Math.abs(left - (hole.left + hole.width + gap)) < 2 : Math.abs(left - (hole.left - CARD_W - gap)) < 2);
  const arrowSide = place === "below" ? "-top-1.5" : place === "above" ? "-bottom-1.5" : place === "right" ? "-left-1.5" : "-right-1.5";

  return (
    <div ref={rootRef} className={cn("pointer-events-none fixed inset-0 z-tour transition-opacity duration-fast", leaving ? "opacity-0" : "opacity-100 animate-fade-in")}
      role="dialog" aria-modal="true" aria-label="Feature tour">
      {/* the spotlight: one element whose giant shadow dims everything AROUND the target */}
      <div className="absolute rounded-xl transition-all duration-base ease-standard motion-reduce:transition-none"
        style={{ ...hole, boxShadow: "0 0 0 200vmax var(--color-scrim)" }} />
      <div className="pointer-events-none absolute rounded-xl ring-2 ring-accent/80 transition-all duration-base ease-standard motion-reduce:transition-none" style={hole} />

      {/* The card remounts per step, so the announcement lives outside it. */}
      <p className="sr-only" aria-live="polite">{asking ? "Skip this tour?" : `Step ${step + 1} of ${steps.length}: ${s.title}`}</p>
      <div ref={cardRef} key={step} className="pointer-events-auto absolute rounded-xl border border-hairline p-4 text-left surface-float shadow-pop animate-fade-up"
        style={{ left, top, width: CARD_W }}>
        {arrowOnCard && <div className={cn("absolute size-3 rotate-45 surface-float", arrowSide)} style={vertical ? { left: arrowPos - 6 } : { top: arrowPos - 6 }} />}
        {asking ? (
          <div role="group" aria-labelledby="tour-skip">
            <h2 id="tour-skip" className="break-words text-callout font-semibold tracking-tight text-foreground">Skip this tour?</h2>
            <p className="mt-1 break-words text-label leading-relaxed text-muted-foreground">It won&rsquo;t show again. Show me around again, in Settings &gt; About, plays every tour.</p>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-1.5">
              <Button variant="ghost" size="sm" autoFocus onClick={keepGoing}>Keep going</Button>
              <Button variant="secondary" size="sm" onClick={() => close("skipped")}>Skip tour</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h2 className="min-w-0 break-words text-callout font-semibold tracking-tight text-foreground">{s.title}</h2>
              <Button variant="ghost" size="sm" icon onClick={skip} aria-label="Skip the tour" className="-mr-1 -mt-1"><X /></Button>
            </div>
            <p className="mt-1 break-words text-label leading-relaxed text-muted-foreground">{s.body}</p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="flex items-center gap-1.5">
                {steps.map((_, i) => (
                  <button key={i} type="button" onClick={() => setStep(i)} aria-label={`Step ${i + 1} of ${steps.length}`} aria-current={i === step ? "step" : undefined}
                    className={cn("h-1.5 rounded-full transition-all motion-reduce:transition-none", i === step ? "w-5 bg-accent" : "w-1.5 bg-foreground/15 hover:bg-foreground/30")} />
                ))}
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {!last && steps.length > 1 && <Button variant="ghost" size="sm" onClick={skip}>Skip</Button>}
                <Button ref={nextRef} variant="primary" size="sm" onClick={() => (last ? close("done") : setStep(step + 1))}>
                  {last ? "Done" : "Next"} {!last && <ArrowRight />}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
