"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Folder, Download, Mic, ArrowRight, X } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";

// First-run walkthrough: four cards, fully skippable, shown once. It teaches the
// flow (pick an agent → give it a folder → one-time model download → how to talk)
// without blocking anything — Skip or Escape closes it forever.
const SEEN_KEY = "openlive-onboarded-v1";

const STEPS = [
  { icon: Bot, title: "Pick who you talk to", body: "OpenLive drives the coding agent you already use — Claude Code, Codex, Cursor, OpenCode, or Hermes — by voice, locally, under your own login. Choose one per conversation from “Talk to”." },
  { icon: Folder, title: "Give it a project folder", body: "An agent works inside one folder — it's the only place it can read and write, and where its session is saved so you can resume from the CLI too." },
  { icon: Download, title: "One download, then it's all local", body: "The voice models (about 200 MB) download once and run entirely on your device. Nothing you say ever leaves your machine." },
  { icon: Mic, title: "Just talk — interrupt any time", body: "It hears when you start and stop. Hold Space to push-to-talk, press Enter to send a held thought, and speak over it to cut it off mid-word." },
] as const;

export function Onboarding() {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { if (!localStorage.getItem(SEEN_KEY)) setShow(true); } catch { /* private mode */ }
  }, []);

  const { contextSafe } = useGSAP(() => {
    if (!show || prefersReduced()) return;
    gsap.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft });
    gsap.fromTo(".ol-onb-card", { autoAlpha: 0, y: 16, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: DUR.slow, ease: EASE.snappy, delay: 0.05 });
  }, { scope: root, dependencies: [show] });

  const close = contextSafe(() => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* */ }
    if (!root.current || prefersReduced()) { setShow(false); return; }
    gsap.to(root.current, { autoAlpha: 0, duration: DUR.fast, ease: EASE.soft, onComplete: () => setShow(false) });
  });

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, close]);

  if (!show) return null;
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;

  return (
    <div ref={root} className="fixed inset-0 z-[65] grid place-items-center bg-black/35 p-6 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Welcome to OpenLive">
      <div className="ol-onb-card w-full max-w-sm rounded-2xl bg-card p-6 text-left shadow-[var(--shadow-pop)]">
        <div className="flex items-start justify-between">
          <span className="grid size-11 place-items-center rounded-xl bg-accent/12 text-accent"><s.icon className="size-5" /></span>
          <button onClick={close} aria-label="Skip the tour"
            className="grid size-8 place-items-center rounded-lg text-faint transition hover:bg-foreground/10 hover:text-foreground"><X className="size-4" /></button>
        </div>
        <h2 className="mt-4 text-[17px] font-semibold tracking-tight text-foreground">{s.title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{s.body}</p>

        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
                className={cn("h-1.5 rounded-full transition-all", i === step ? "w-5 bg-accent" : "w-1.5 bg-foreground/15 hover:bg-foreground/30")} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {!last && <button onClick={close} className="rounded-lg px-3 py-2 text-[12.5px] font-medium text-muted-foreground transition hover:text-foreground">Skip</button>}
            <button onClick={() => (last ? close() : setStep(step + 1))}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-accent-foreground transition hover:opacity-90">
              {last ? "Start talking" : "Next"} {!last && <ArrowRight className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
