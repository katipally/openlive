import { cn } from "@/lib/cn";

// One key, drawn as a keycap. The hairline keeps it legible on a popover.
export function Keycap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-grid min-w-[1.6em] place-items-center rounded-md border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-caption text-foreground shadow-xs", className)}>
      {children}
    </kbd>
  );
}

/** A hotkey as its keys, one cap each (⌃ ⌃, Shift Right Alt). `label` is what a
 *  screen reader says in place of the symbols. */
export function Keycaps({ keys, label, className }: { keys: readonly string[]; label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} className={cn("inline-flex shrink-0 flex-wrap items-center gap-1", className)}>
      {keys.map((k, i) => <Keycap key={i} className="text-label">{k}</Keycap>)}
    </span>
  );
}
