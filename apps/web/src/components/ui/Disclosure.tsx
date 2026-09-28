"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Smoothly animated open/close for a collapsible region. Uses the grid-rows
 *  0fr↔1fr trick — a pure-CSS height transition with no JS measuring — so tool
 *  cards, work blocks and disclosures glide open/closed instead of snapping.
 *  The caller owns the `open` state and its toggle button; this only animates the
 *  body. Content stays mounted (clipped when closed), so keep heavy bodies lazy
 *  upstream if that ever matters. Closed content is inert, so Tab never lands
 *  inside a region nobody can see. Once fully open the body stops clipping, so a
 *  dropdown inside it can hang past its edge. */
export function Disclosure({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [clip, setClip] = useState(!open);
  useEffect(() => {
    // With motion reduced there is no transition to end, so it opens unclipped at once.
    if (!open) setClip(true);
    else if (matchMedia("(prefers-reduced-motion: reduce)").matches) setClip(false);
  }, [open]);
  return (
    <div onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === "grid-template-rows" && open) setClip(false); }}
      className={cn(
        "grid transition-[grid-template-rows] duration-base ease-out-quart motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}>
      <div inert={!open} className={cn("min-h-0 transition-opacity duration-base ease-out-quart", !open && "opacity-0", clip && "overflow-hidden", className)}>{children}</div>
    </div>
  );
}
