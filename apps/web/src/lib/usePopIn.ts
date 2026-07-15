"use client";

import type { RefObject } from "react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";

// Subtle enter for popovers/menus: fade + rise + a slight scale from the top edge.
// Enter-only — menus unmount instantly on close, which reads fine for a menu.
// Targets the element directly (no selector), so no scope is needed; useGSAP
// reverts on unmount and re-runs when `open` flips.
export function usePopIn(ref: RefObject<HTMLElement | null>, open: boolean) {
  useGSAP(() => {
    if (!open || !ref.current || prefersReduced()) return;
    gsap.fromTo(ref.current, { autoAlpha: 0, y: -6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, transformOrigin: "top center", duration: DUR.fast, ease: EASE.out });
  }, { dependencies: [open] });
}
