"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Smoothly animated open/close for a collapsible region. Uses the grid-rows
 *  0fr↔1fr trick — a pure-CSS height transition with no JS measuring — so tool
 *  cards, work blocks and disclosures glide open/closed instead of snapping.
 *  The caller owns the `open` state and its toggle button; this only animates the
 *  body. Content stays mounted (clipped when closed), so keep heavy bodies lazy
 *  upstream if that ever matters. */
export function Disclosure({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      "grid transition-[grid-template-rows] duration-[var(--dur-base)] ease-[var(--ease-out-quart)] motion-reduce:transition-none",
      open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
    )}>
      <div className={cn("min-h-0 overflow-hidden", className)}>{children}</div>
    </div>
  );
}
