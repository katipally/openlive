import { toolMeta } from "@/lib/live/toolMeta";
import { monogram } from "@/lib/connectors";
import { cn } from "@/lib/cn";

/** A tool's mark in a row: a connector tool's monogram, else the tool's icon. */
export function ToolGlyph({ tool, className }: { tool: string; className?: string }) {
  const m = toolMeta(tool);
  if (m.connector) return (
    <span aria-hidden className={cn("grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-sm bg-track px-0.5 font-mono text-micro font-semibold leading-none text-muted-foreground", className)}>
      {monogram(m.connector)}
    </span>
  );
  return <m.icon aria-hidden className={cn("size-3.5 shrink-0 text-faint", className)} />;
}
