"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

/** Checkbox's round sibling. The real radio sits on top, invisible, so arrow keys,
 *  labels and radio semantics stay native. Radios sharing a `name` form one group;
 *  wrap a set in RadioGroup, or in your own role="radiogroup" when the rows carry more. */
export function Radio({ className, disabled, ...input }: Omit<ComponentProps<"input">, "type" | "checked"> & { checked: boolean }) {
  const { snappy } = useMotionTokens();
  return (
    <span className={cn("relative grid size-[1.125rem] shrink-0 place-items-center rounded-full transition-[background-color,box-shadow,scale] motion-safe:active:scale-[0.88] active:duration-press has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50",
      input.checked ? "bg-accent" : "shadow-mark", disabled && "opacity-40", className)}>
      <input type="radio" disabled={disabled} {...input}
        className="absolute inset-0 m-0 cursor-[inherit] appearance-none rounded-full opacity-0" />
      <motion.span aria-hidden className="pointer-events-none size-1.5 rounded-full bg-accent-foreground"
        initial={false} animate={{ scale: input.checked ? 1 : 0 }} transition={snappy} />
    </span>
  );
}

export interface RadioOption<T extends string> { value: T; label: ReactNode; detail?: ReactNode; disabled?: boolean }

/** A labelled set of radios, one per row. */
export function RadioGroup<T extends string>({ label, value, onChange, options, name, className }: {
  label: string; value: T | undefined; onChange: (v: T) => void; options: RadioOption<T>[]; name?: string; className?: string;
}) {
  const auto = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-col gap-0.5", className)}>
      {options.map((o) => (
        <label key={o.value} className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-body transition",
          o.disabled ? "cursor-default text-muted-foreground" : "cursor-pointer text-foreground hover:bg-foreground/[0.06]")}>
          <Radio name={name ?? auto} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span className="flex min-w-0 flex-col break-words">
            {o.label}
            {o.detail && <span className="text-caption text-muted-foreground">{o.detail}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
