"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { usePersistedOpen } from "@/lib/disclosure";
import { cn } from "@/lib/cn";

/** The knobs most people never touch, folded under one line. Closed until
 *  opened, then remembered per `id` on this machine. Glides open where the
 *  engine can size to auto (globals.css `details`). */
export function Advanced({ id, label = "Advanced", children, className }: { id: string; label?: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = usePersistedOpen(`settings:${id}`);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={cn("group", className)}>
      <summary className="flex min-h-control-md cursor-pointer list-none items-center gap-1.5 text-label font-medium text-muted-foreground transition hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {label}
      </summary>
      <div className="flex flex-col gap-4 pb-1 pt-3">{children}</div>
    </details>
  );
}
