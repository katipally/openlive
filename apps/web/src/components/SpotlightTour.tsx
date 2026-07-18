"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/cn";

// Reusable first-visit SPOTLIGHT tour: dims the page with a cutout + accent ring
// around the ACTUAL control (found by [data-tour="…"]) and points an arrowed
// tooltip at it. Each surface mounts its own <SpotlightTour id steps/> — the
// tour runs ONCE per id (localStorage), is fully skippable (Skip/Escape/×), and
// follows the target on resize. Pure CSS motion (fade/slide keyframes + hole
// transitions) — no imperative animation against elements that may not exist,
// which is what made the previous GSAP version spam "target not found".
export interface TourStep { target: string; title: string; body: string }

const seenKey = (id: string) => `openlive-tour-${id}`;
export const tourSeen = (id: string): boolean => { try { return !!localStorage.getItem(seenKey(id)); } catch { return true; } };
const markSeen = (id: string) => { try { localStorage.setItem(seenKey(id), "1"); } catch { /* private mode */ } };

export function SpotlightTour({ id, steps, active = true }: { id: string; steps: TourStep[]; active?: boolean }) {
  const [show, setShow] = useState(false);
  // Defer the start slightly so the surface's own entrance animation finishes
  // and the anchors are where they'll stay.
  useEffect(() => {
    if (!active || tourSeen(id)) return;
    const t = setTimeout(() => setShow(true), 650);
    return () => clearTimeout(t);
  }, [id, active]);
  if (!show || !active) return null;
  return <Tour steps={steps} onClose={() => { markSeen(id); setShow(false); }} />;
}

const CARD_W = 330;

// Inner component mounts ONLY while the tour is live, so every hook and DOM
// measurement runs against elements that actually exist.
function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(190); // measured after render so vertical clamping is exact

  // Poll the anchor (rAF-throttled) so the spotlight FOLLOWS layout changes, and —
  // critically — CLOSE the tour if the target disappears (the user navigated away or
  // opened Settings over the surface). Without this a stale rect stranded the bubble
  // on screen. Only setRect on an actual change so we don't re-render every frame.
  useEffect(() => {
    const sel = `[data-tour="${steps[step]!.target}"]`;
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
        else if (t - missingSince > 400) { onClose(); return; } // anchor gone for good → don't strand
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, steps, onClose]);

  const close = useCallback(() => { setLeaving(true); setTimeout(onClose, 180); }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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
    <div className={cn("fixed inset-0 z-[65] transition-opacity duration-200", leaving ? "opacity-0" : "opacity-100 animate-[fade-up_0.2s_ease-out]")}
      role="dialog" aria-modal="true" aria-label="Feature tour">
      {/* the spotlight: one element whose giant shadow dims everything AROUND the target */}
      <div className="absolute rounded-2xl transition-all duration-300 ease-out"
        style={{ ...hole, boxShadow: "0 0 0 200vmax rgba(0,0,0,0.55)" }} onClick={close} />
      <div className="pointer-events-none absolute rounded-2xl ring-2 ring-accent/80 transition-all duration-300 ease-out" style={hole} />

      <div ref={cardRef} key={step} className="absolute w-[330px] rounded-2xl bg-card p-4 text-left shadow-[var(--shadow-pop)] animate-fade-up"
        style={{ left, top }}>
        {arrowOnCard && <div className={cn("absolute size-3 rotate-45 bg-card", arrowSide)} style={vertical ? { left: arrowPos - 6 } : { top: arrowPos - 6 }} />}
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-callout font-semibold tracking-tight text-foreground">{s.title}</h2>
          <button onClick={close} aria-label="Skip the tour"
            className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-foreground/10 hover:text-foreground"><X className="size-3.5" /></button>
        </div>
        <p className="mt-1 text-label leading-relaxed text-muted-foreground">{s.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {steps.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
                className={cn("h-1.5 rounded-full transition-all", i === step ? "w-5 bg-accent" : "w-1.5 bg-foreground/15 hover:bg-foreground/30")} />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {!last && steps.length > 1 && <button onClick={close} className="rounded-lg px-2.5 py-1.5 text-label font-medium text-muted-foreground transition hover:text-foreground">Skip</button>}
            <button onClick={() => (last ? close() : setStep(step + 1))}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-label font-medium text-accent-foreground transition hover:opacity-90">
              {last ? "Done" : "Next"} {!last && <ArrowRight className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
