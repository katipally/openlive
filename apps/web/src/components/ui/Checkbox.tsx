"use client";

import type { ComponentProps } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

/** A checkbox that gives under a press and draws its tick. The real input sits on top,
 *  invisible, so keyboard, labels and forms behave exactly as native. Wrap it
 *  in a <label> with its text; the label sets the cursor and, when disabled, the dimming. */
export function Checkbox({ className, disabled, ...input }: Omit<ComponentProps<"input">, "type" | "checked"> & { checked: boolean }) {
  const { snappy, fade } = useMotionTokens();
  return (
    <motion.span initial={false} animate={{ scale: 1 }} whileTap={disabled ? undefined : { scale: 0.88 }}
      transition={snappy}
      className={cn("relative grid size-[1.125rem] shrink-0 place-items-center rounded-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50",
        input.checked ? "bg-accent" : "shadow-mark", className)}>
      <input type="checkbox" disabled={disabled} {...input}
        className="absolute inset-0 m-0 cursor-[inherit] appearance-none opacity-0" />
      <svg viewBox="0 0 16 16" className="pointer-events-none size-3 text-accent-foreground" aria-hidden>
        <motion.path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
          initial={false} animate={{ pathLength: input.checked ? 1 : 0, opacity: input.checked ? 1 : 0 }} transition={fade} />
      </svg>
    </motion.span>
  );
}
