"use client";

import { useCallback, useEffect, useState } from "react";
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

// Inner component mounts ONLY while the tour is live, so every hook and DOM
// measurement runs against elements that actually exist.
function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const measure = () => setRect(document.querySelector(`[data-tour="${steps[step]!.target}"]`)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, steps]);

  const close = useCallback(() => { setLeaving(true); setTimeout(onClose, 180); }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Anchor missing (layout changed, element hidden) → never strand a dim overlay.
  useEffect(() => { if (rect === null) { const t = setTimeout(() => { if (!document.querySelector(`[data-tour="${steps[step]!.target}"]`)) onClose(); }, 300); return () => clearTimeout(t); } }, [rect, step, steps, onClose]);

  if (!rect) return null;
  const s = steps[step]!;
  const last = step === steps.length - 1;

  const pad = 10;
  const hole = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const below = hole.top + hole.height + 200 < window.innerHeight;
  const cardW = 330;
  const cardLeft = Math.max(16, Math.min(window.innerWidth - cardW - 16, hole.left + hole.width / 2 - cardW / 2));
  const arrowX = Math.max(20, Math.min(cardW - 20, hole.left + hole.width / 2 - cardLeft));

  return (
    <div className={cn("fixed inset-0 z-[65] transition-opacity duration-200", leaving ? "opacity-0" : "opacity-100 animate-[fade-up_0.2s_ease-out]")}
      role="dialog" aria-modal="true" aria-label="Feature tour">
      {/* the spotlight: one element whose giant shadow dims everything AROUND the target */}
      <div className="absolute rounded-2xl transition-all duration-300 ease-out"
        style={{ ...hole, boxShadow: "0 0 0 200vmax rgba(0,0,0,0.55)" }} onClick={close} />
      <div className="pointer-events-none absolute rounded-2xl ring-2 ring-accent/80 transition-all duration-300 ease-out" style={hole} />

      <div key={step} className="absolute w-[330px] rounded-2xl bg-card p-4 text-left shadow-[var(--shadow-pop)] animate-fade-up"
        style={{ left: cardLeft, top: below ? hole.top + hole.height + 14 : undefined, bottom: below ? undefined : window.innerHeight - hole.top + 14 }}>
        <div className={cn("absolute size-3 rotate-45 bg-card", below ? "-top-1.5" : "-bottom-1.5")} style={{ left: arrowX - 6 }} />
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-[14.5px] font-semibold tracking-tight text-foreground">{s.title}</h2>
          <button onClick={close} aria-label="Skip the tour"
            className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-foreground/10 hover:text-foreground"><X className="size-3.5" /></button>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {steps.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
                className={cn("h-1.5 rounded-full transition-all", i === step ? "w-5 bg-accent" : "w-1.5 bg-foreground/15 hover:bg-foreground/30")} />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {!last && steps.length > 1 && <button onClick={close} className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition hover:text-foreground">Skip</button>}
            <button onClick={() => (last ? close() : setStep(step + 1))}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-foreground transition hover:opacity-90">
              {last ? "Done" : "Next"} {!last && <ArrowRight className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
