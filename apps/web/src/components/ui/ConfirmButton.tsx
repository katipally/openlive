"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";
import { buttonClass, type ButtonSize } from "./Button";
import { menuItem } from "./Menu";

/** A delete that asks once, in place: the first press arms it, the second runs it,
 *  and leaving it disarms it. A Button everywhere, a menu item inside a menu. */
export function ConfirmButton({ label, confirm, onConfirm, disabled, className, role, size = "sm" }: {
  label: string; confirm: string; onConfirm: () => void | Promise<unknown>; disabled?: boolean; className?: string; role?: "menuitem"; size?: ButtonSize;
}) {
  const [armed, setArmed] = useState(false);
  const { snappy, fade } = useMotionTokens();
  const look = role === "menuitem"
    ? cn(menuItem, "font-medium aria-disabled:cursor-not-allowed aria-disabled:opacity-40", armed ? "bg-destructive-fill text-white hover:bg-destructive-fill" : "text-destructive-text aria-disabled:hover:bg-transparent")
    : cn(buttonClass({ variant: armed ? "destructive" : "ghost", size }), !armed && "text-destructive-text enabled:hover:bg-destructive/10 enabled:hover:text-destructive-text aria-disabled:enabled:hover:bg-transparent");
  // The button eases to its new width while the words cross-fade inside it.
  return (
    <motion.button type="button" role={role} aria-disabled={disabled || undefined} onBlur={() => setArmed(false)} layout transition={snappy}
      style={role === "menuitem" ? undefined : { borderRadius: 999 }}
      onClick={() => { if (disabled) return; if (armed) { setArmed(false); void onConfirm(); } else setArmed(true); }}
      className={cn(look, "text-label", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={armed ? "confirm" : "label"} layout="position" className="inline-block whitespace-nowrap"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
          {armed ? confirm : label}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
