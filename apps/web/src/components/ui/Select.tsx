import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** The closed look of every dropdown, native or not: one height, radius, fill. */
export const fieldTrigger = "h-field min-w-0 rounded-md border border-border bg-control px-3 text-body text-foreground shadow-xs transition";

// The app's one native dropdown. Native on purpose: the OS draws the list, so
// keyboard, screen readers and very long lists come for free. A choice that
// needs brand marks or a second line per option uses the Picker menu instead.
export function Select({ className, ...rest }: ComponentProps<"select">) {
  return (
    <select {...rest}
      className={cn("ol-select max-w-full truncate outline-none focus:border-border-heavy disabled:cursor-not-allowed disabled:opacity-50", fieldTrigger, className)} />
  );
}
