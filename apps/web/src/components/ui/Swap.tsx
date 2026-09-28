"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

/** One icon (or short word) turning into another when `id` changes: the old
 *  one shrinks away as the new one springs up in the same spot. Both share one
 *  grid cell while they cross, so nothing around them moves. */
export function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const { snappy, fade } = useMotionTokens();
  return (
    <span className={cn("inline-grid place-items-center [&>*]:[grid-area:1/1]", className)}>
      <AnimatePresence initial={false}>
        <motion.span key={id} className="inline-grid place-items-center"
          initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}
          transition={{ ...snappy, opacity: fade }}>
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
