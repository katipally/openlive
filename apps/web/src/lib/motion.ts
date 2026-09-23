"use client";

import { useReducedMotion } from "motion/react";

// motion/react's half of the vocabulary in lib/gsap.ts: GSAP keeps the older
// timelines, this is for what React mounts, unmounts and toggles. Springs for
// things that move, a short ease-out fade for things that appear.

export const SPRING = { type: "spring", visualDuration: 0.32, bounce: 0.22 } as const;
export const FADE = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;
const INSTANT = { duration: 0 } as const;

/** Menus and popovers: the same numbers as usePopIn's GSAP pop, so both kinds read alike. */
export const POP = {
  initial: { opacity: 0, y: -6, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.97 },
} as const;

/** The transitions to use right now: instant ones when the person asked for less motion. */
export function useMotionTokens() {
  const reduce = !!useReducedMotion();
  return reduce ? { reduce, spring: INSTANT, fade: INSTANT } : { reduce, spring: SPRING, fade: FADE };
}
