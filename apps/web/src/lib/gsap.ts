"use client";

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

// GSAP is left for one caller, the Flow orb (components/flow/FlowOrb.tsx), until
// the orb's own redesign moves it to motion/react. Everything else animates with
// motion/react on the spec in lib/motion.ts. Register the React hook once, here.
// Runs client-only (the caller is "use client").
gsap.registerPlugin(useGSAP);

export const DUR = { fast: 0.22 } as const;
export const EASE = { out: "power2.out" } as const;

// Reduced-motion check as a plain boolean. Prefer this over gsap.matchMedia()
// *inside* useGSAP: a nested matchMedia context isn't reverted by useGSAP's
// cleanup, so under React 19 StrictMode's mount→unmount→mount the `from` start
// state can stick and leave elements invisible.
export const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export { gsap, useGSAP };
