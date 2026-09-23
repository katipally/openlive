import { cn } from "@/lib/cn";

// One key, drawn as a keycap. The hairline keeps it legible on a popover.
export function Keycap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-grid min-w-[1.6em] place-items-center rounded-md border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-caption text-foreground shadow-[inset_0_-1px_0_rgba(0,0,0,.1)]", className)}>
      {children}
    </kbd>
  );
}
