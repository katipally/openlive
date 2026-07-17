"use client";

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

// GSAP is the app's one motion system. Register the React hook once, here, so
// every component can `import { gsap, useGSAP } from "@/lib/gsap"` and get a
// ready plugin. Runs client-only (all callers are "use client").
gsap.registerPlugin(useGSAP);

// One motion vocabulary — the SINGLE source of truth for timing, mirrored into
// the CSS tokens in globals.css (keep the two in sync). Apple-HIG buttery:
// unhurried, smooth-settling, a subtle overshoot on entrances — never the hard
// decelerating stop that reads as "snappy". Deliberately longer than a web default.
export const DUR = { fast: 0.22, base: 0.34, slow: 0.44, enter: 0.55 } as const;
export const EASE = {
  out: "power2.out",        // buttery general settle — gentle, long tail (was power3, a harder stop)
  settle: "back.out(1.4)",  // entrance with a subtle overshoot — the buttery "pop"
  snappy: "power3.out",     // small crisp moves (menu pops) — still eased, not the old power4
  inOut: "power2.inOut",    // smooth symmetric moves
  soft: "power1.out",       // subtle fades
  emphasized: "expo.out",   // orchestrated hero / screen transitions
} as const;
// ponytail: built-in eases are enough here; CustomEase (a free GSAP plugin) is the
// upgrade path if we ever want a hand-tuned single curve across CSS + JS.

// ── Shared timeline presets ──────────────────────────────────────────────────
// RULES (perf contract with the WebGPU voice pipeline): transforms/opacity ONLY,
// every timeline lives inside a useGSAP scope, prefersReduced() short-circuits
// to the final state, and NOTHING loops while a call is active.

/** Rise-and-settle entrance for one element or a selector within a scope. */
export function enterUp(targets: gsap.TweenTarget, opts: gsap.TweenVars = {}) {
  return gsap.fromTo(targets,
    { autoAlpha: 0, y: 12 },
    { autoAlpha: 1, y: 0, duration: DUR.enter, ease: EASE.settle, ...opts });
}

/** Staggered entrance for a list of elements (menus, history rows, tab content). */
export function staggerIn(targets: gsap.TweenTarget, opts: gsap.TweenVars = {}) {
  return gsap.fromTo(targets,
    { autoAlpha: 0, y: 8 },
    { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.03, ...opts });
}

// Reduced-motion check as a plain boolean. Prefer this over gsap.matchMedia()
// *inside* useGSAP — a nested matchMedia context isn't reverted by useGSAP's
// cleanup, so under React 19 StrictMode's mount→unmount→mount the `from` start
// state can stick and leave elements invisible.
export const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export { gsap, useGSAP };
