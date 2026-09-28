import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// A tinted note in the flow of a page: something is off, what it means, and
// often the one thing to do about it. Warning is the default (a missing key, a
// slow path); danger is for what will not work at all. A leading svg is sized
// and aligned for you. For a note that is itself the fix, put `notice(tone)` on
// a <button>.

const TONE = {
  warning: "border-arc/40 bg-arc-soft text-arc-text",
  danger: "border-destructive/30 bg-destructive/10 text-destructive-text",
  info: "border-accent/30 bg-accent-soft text-foreground",
} as const;
const PRESS = { warning: "hover:bg-arc/15", danger: "hover:bg-destructive/15", info: "hover:bg-accent/15" } as const;

export type NoticeTone = keyof typeof TONE;

export const notice = (tone: NoticeTone = "warning", pressable = false) => cn(
  "flex min-w-0 items-start gap-2 break-words rounded-lg border px-3 py-2.5 text-left text-label leading-relaxed [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  TONE[tone], pressable && cn("transition", PRESS[tone]),
);

export function Notice({ tone, className, ...rest }: ComponentProps<"div"> & { tone?: NoticeTone }) {
  return <div className={cn(notice(tone), className)} {...rest} />;
}
