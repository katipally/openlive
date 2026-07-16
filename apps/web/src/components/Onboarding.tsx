"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";

// First-run walkthrough as a real SPOTLIGHT tour: each step dims the page,
// cuts a hole around the actual control (via a huge box-shadow), and points a
// tooltip at it — so the guide shows WHERE things are, not just what they do.
// Fully skippable (Skip / Escape / ×), shown once, recomputes on resize.
const SEEN_KEY = "openlive-onboarded-v2";

const STEPS: { target: string; title: string; body: string }[] = [
  { target: "talk-to", title: "Pick who you talk to", body: "OpenLive voice-drives the coding agent you already use — Claude Code, Codex, Cursor, OpenCode, or Hermes — locally, under your own login. Pick one here (or keep the built-in assistant)." },
  { target: "new", title: "Start a conversation", body: "New opens the call setup: choose a project folder for a coding agent (the only place it reads and writes), check your mic and camera, then Start. Just talk — interrupt any time." },
  { target: "resume", title: "Everything is saved", body: "Resume lists every conversation by project folder — including sessions you started in the agent's own CLI. Reopen one and the agent picks up right where it left off." },
  { target: "settings", title: "Make it yours", body: "Settings holds the voice pipeline (speech models, TTS engine and voice, turn-taking feel), agent install & sign-in, appearance, and shortcuts." },
];

const rectFor = (target: string): DOMRect | null =>
  document.querySelector(`[data-tour="${target}"]`)?.getBoundingClientRect() ?? null;

export function Onboarding() {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { if (!localStorage.getItem(SEEN_KEY)) setShow(true); } catch { /* private mode */ }
  }, []);

  // Track the current step's anchor (and follow it on resize).
  useEffect(() => {
    if (!show) return;
    const measure = () => setRect(rectFor(STEPS[step]!.target));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [show, step]);

  const { contextSafe } = useGSAP(() => {
    if (!show || prefersReduced()) return;
    gsap.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft });
  }, { scope: root, dependencies: [show] });

  // Cross-fade the tooltip between steps.
  useGSAP(() => {
    if (!show || prefersReduced()) return;
    gsap.fromTo(".ol-tour-card", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out });
  }, { scope: root, dependencies: [step, show] });

  const close = useCallback(() => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* */ }
    const el = root.current;
    if (!el || prefersReduced()) { setShow(false); return; }
    gsap.to(el, { autoAlpha: 0, duration: DUR.fast, ease: EASE.soft, onComplete: () => setShow(false) });
  }, []);
  const closeSafe = contextSafe(close);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSafe(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, closeSafe]);

  if (!show || !rect) return null;
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;

  // Spotlight geometry: a rounded cutout hugging the control; the tooltip sits
  // below it (or above when the control is low on screen), arrow pointing back.
  const pad = 10;
  const hole = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const below = hole.top + hole.height + 190 < window.innerHeight;
  const cardW = 330;
  const cardLeft = Math.max(16, Math.min(window.innerWidth - cardW - 16, hole.left + hole.width / 2 - cardW / 2));
  const arrowX = Math.max(20, Math.min(cardW - 20, hole.left + hole.width / 2 - cardLeft));

  return (
    <div ref={root} className="fixed inset-0 z-[65]" role="dialog" aria-modal="true" aria-label="Welcome tour">
      {/* the spotlight: one element whose giant shadow dims everything AROUND the target */}
      <div className="absolute rounded-2xl transition-all duration-300 ease-out"
        style={{ ...hole, boxShadow: "0 0 0 200vmax rgba(0,0,0,0.55)" }} onClick={closeSafe} />
      {/* a soft ring so the highlighted control reads as highlighted, not just un-dimmed */}
      <div className="pointer-events-none absolute rounded-2xl ring-2 ring-accent/80 transition-all duration-300 ease-out" style={hole} />

      <div className="ol-tour-card absolute w-[330px] rounded-2xl bg-card p-4 text-left shadow-[var(--shadow-pop)]"
        style={{ left: cardLeft, top: below ? hole.top + hole.height + 14 : undefined, bottom: below ? undefined : window.innerHeight - hole.top + 14 }}>
        {/* arrow pointing at the control */}
        <div className={cn("absolute size-3 rotate-45 bg-card", below ? "-top-1.5" : "-bottom-1.5")} style={{ left: arrowX - 6 }} />
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-[14.5px] font-semibold tracking-tight text-foreground">{s.title}</h2>
          <button onClick={closeSafe} aria-label="Skip the tour"
            className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-foreground/10 hover:text-foreground"><X className="size-3.5" /></button>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
                className={cn("h-1.5 rounded-full transition-all", i === step ? "w-5 bg-accent" : "w-1.5 bg-foreground/15 hover:bg-foreground/30")} />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {!last && <button onClick={closeSafe} className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition hover:text-foreground">Skip</button>}
            <button onClick={() => (last ? closeSafe() : setStep(step + 1))}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-foreground transition hover:opacity-90">
              {last ? "Done" : "Next"} {!last && <ArrowRight className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
