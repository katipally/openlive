"use client";

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

// GSAP is the app's one motion system. Register the React hook once, here, so
// every component can `import { gsap, useGSAP } from "@/lib/gsap"` and get a
// ready plugin. Runs client-only (all callers are "use client").
gsap.registerPlugin(useGSAP);

// One motion vocabulary — mirrors the CSS tokens in globals.css so GSAP-driven
// surfaces feel identical to the CSS ones. Apple-HIG-ish: short, eased, a touch
// of spring on entrances, nothing gaudy.
export const DUR = { fast: 0.16, base: 0.24, slow: 0.34, enter: 0.44 } as const;
export const EASE = {
  out: "power3.out",       // general settle — ≈ the CSS ease-out-quart
  snappy: "power4.out",    // crisp entrance
  inOut: "power2.inOut",   // symmetric moves
  soft: "power1.out",      // subtle fades
  emphasized: "expo.out",  // orchestrated moments (hero, screen transitions)
} as const;

// ── Shared timeline presets ──────────────────────────────────────────────────
// RULES (perf contract with the WebGPU voice pipeline): transforms/opacity ONLY,
// every timeline lives inside a useGSAP scope, prefersReduced() short-circuits
// to the final state, and NOTHING loops while a call is active.

/** Rise-and-settle entrance for one element or a selector within a scope. */
export function enterUp(targets: gsap.TweenTarget, opts: gsap.TweenVars = {}) {
  return gsap.fromTo(targets,
    { autoAlpha: 0, y: 10 },
    { autoAlpha: 1, y: 0, duration: DUR.enter, ease: EASE.emphasized, ...opts });
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
