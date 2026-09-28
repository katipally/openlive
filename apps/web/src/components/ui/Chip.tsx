import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Two small labels from the kit. A Chip is a capsule that states something
// (a status with its dot, a mode, a fact); a Badge is a tight tag beside a
// title (New, Experimental, Active). Both wrap long text instead of clipping.

const DOT = { success: "bg-success", arc: "bg-arc", accent: "bg-accent", muted: "bg-muted-foreground", danger: "bg-destructive-fill" } as const;

export function Chip({ children, dot, className }: { children: ReactNode; dot?: keyof typeof DOT; className?: string }) {
  return (
    <span className={cn("inline-flex min-h-6 max-w-full items-center gap-1.5 break-words rounded-full bg-chip px-2.5 py-0.5 text-caption font-medium text-muted-strong [&_svg]:size-3 [&_svg]:shrink-0", className)}>
      {dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[dot])} />}
      {children}
    </span>
  );
}

/** A capsule you press: it opens a menu or a setting (the call's top bar, the
 *  agent picker, Flow's brain and access). A Chip only states. */
export const pill = "flex h-field max-w-[min(13.75rem,100%)] items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 text-label font-medium text-foreground shadow-rim transition enabled:hover:border-border-heavy [&_svg]:size-3.5 [&_svg]:shrink-0";

const TONE = {
  neutral: "bg-chip text-muted-foreground",
  accent: "bg-accent-soft text-link-foreground",
  arc: "bg-arc-soft text-arc-text",
  danger: "bg-destructive/10 text-destructive-text",
} as const;

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: keyof typeof TONE; className?: string }) {
  return (
    <span className={cn("inline-flex min-h-[1.125rem] max-w-full items-center gap-1 break-words rounded-sm px-1.5 text-micro font-semibold [&_svg]:size-2.5 [&_svg]:shrink-0", TONE[tone], className)}>
      {children}
    </span>
  );
}
