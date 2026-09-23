"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

// The app's one on/off switch. The knob springs across and, while pressed,
// stretches toward the side it is about to go to. It travels exactly its own
// width (track = two knobs plus the inset), so the move is in percent and holds
// at any root font size.
export function Switch({ on, onFlip, className }: { on: boolean; onFlip: () => void; className?: string }) {
  const { spring } = useMotionTokens();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onFlip}
      className={cn("group relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-foreground/15", className)}>
      <motion.span aria-hidden initial={false} animate={{ x: on ? "100%" : "0%" }} transition={spring}
        className="absolute left-0.5 top-0.5 block size-4">
        <span className={cn("block size-full rounded-full bg-white shadow transition-transform duration-150 motion-safe:group-active:scale-x-[1.25]",
          on ? "origin-left" : "origin-right")} />
      </motion.span>
    </button>
  );
}
