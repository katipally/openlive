import { cn } from "@/lib/cn";

// The app's segmented control, as Settings → General draws it. Flow reuses the
// exact classes for its mode switch and its activation picker rather than
// inventing a second look for the same control.
export const segWrap = "inline-flex rounded-lg bg-card p-1 shadow-[var(--shadow-card)]";
export const segBtn = (on: boolean) =>
  cn("flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-label font-medium transition",
    on ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground");
