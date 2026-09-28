"use client";

import { animate, useReducedMotion, type AnimationOptions, type DOMKeyframesDefinition } from "motion/react";

// The motion spec. motion/react is the one motion system (the Flow orb alone
// still runs on GSAP, lib/gsap.ts). Apple's rules: purposeful, quick,
// interruptible, spring-based, and Reduce Motion honoured.
//
//   SNAPPY  presses, toggles, thumbs, highlights, check marks. Lands in ~0.2s, a hint of bounce.
//   SMOOTH  menus, popovers, panels, sheets, the drawer. ~0.3s, no bounce.
//   GENTLE  layout: a list reflowing, a height, a shared element travelling. ~0.42s.
//   FADE    what appears in place: tooltips, cross-fades, captions. 0.18s ease-out.
//   EXIT    what leaves: quicker than it came, accelerating away.
//   SHEET   a full-height sheet sliding in: eased, since a spring over that
//           distance trails for a visible while.
//   STAGGER lists, on their FIRST reveal only (never on a data update), capped at
//           STAGGER_MAX rows so a long list never trails.
//
// A spring starts from wherever an interrupted animation left off, at its
// velocity, so reversing mid-flight never jumps. Only transform and opacity
// animate. Reduce Motion: movement goes, a short fade stays (useMotionTokens).
// CSS twins in globals.css: --ease-spring and --dur-spring (SNAPPY),
// --ease-standard and --dur-fast (FADE), --dur-press.

export const SNAPPY = { type: "spring", visualDuration: 0.2, bounce: 0.15 } as const;
export const SMOOTH = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;
export const GENTLE = { type: "spring", visualDuration: 0.42, bounce: 0.1 } as const;
export const FADE = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;
export const EXIT = { duration: 0.14, ease: [0.4, 0, 1, 1] } as const;
export const SHEET = { duration: 0.3, ease: FADE.ease } as const;
export const STAGGER_S = 0.025;
export const STAGGER_MAX = 12;
const INSTANT = { duration: 0 } as const;
const REDUCED_FADE = { duration: 0.12, ease: "easeOut" } as const;

/** Seconds before the `i`th item of a first reveal starts. */
export const staggerDelay = (i: number) => Math.min(Math.max(0, i), STAGGER_MAX) * STAGGER_S;

/** A menu or popover, closed: a touch small and nudged toward its trigger. */
export const POP = { opacity: 0, scale: 0.96, y: 4 } as const;

type Box = { left: number; top: number; width: number; height: number };

/** Where a popover grows from: the point of its edge nearest the trigger's
 *  centre, so it reads as coming out of what was pressed. `below` says the
 *  panel hangs under the trigger (grows down) rather than over it. */
export function popOrigin(panel: Box, trigger: Box | null): { x: number; below: boolean } {
  if (!trigger) return { x: panel.width / 2, below: true };
  const centre = trigger.left + trigger.width / 2 - panel.left;
  return {
    x: Math.min(panel.width, Math.max(0, centre)),
    below: panel.top + panel.height / 2 >= trigger.top + trigger.height / 2,
  };
}

/** The transitions to use right now. With Reduce Motion, anything that moves
 *  is instant and fades stay, short. */
export function useMotionTokens() {
  const reduce = !!useReducedMotion();
  return reduce
    ? { reduce, snappy: INSTANT, smooth: INSTANT, gentle: INSTANT, fade: REDUCED_FADE, exit: REDUCED_FADE, sheet: INSTANT }
    : { reduce, snappy: SNAPPY, smooth: SMOOTH, gentle: GENTLE, fade: FADE, exit: EXIT, sheet: SHEET };
}

/** Animates what `selector` matches inside `root` right now. A selector that
 *  matches nothing (a part not rendered at the moment) is skipped: motion
 *  treats an empty target as an error. Await the result to chain. */
export function animateAll(root: Element, selector: string, keyframes: DOMKeyframesDefinition, options: AnimationOptions) {
  const els = root.querySelectorAll(selector);
  return els.length ? animate(els, keyframes, options) : undefined;
}
