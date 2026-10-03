"use client";

import { Switch } from "@/components/ui";
import { cn } from "@/lib/cn";

/** A mode's on/off. It lives on that mode's home only; Settings says the state and links here. */
export function PowerPill({ name, on, onFlip, disabled }: { name: string; on: boolean; onFlip: () => void; disabled?: boolean }) {
  return (
    <label className={cn("flex min-h-control-lg max-w-full cursor-pointer items-center gap-3 rounded-full border border-border bg-secondary py-1.5 pl-4 pr-2 shadow-rim transition hover:border-border-heavy",
      disabled && "pointer-events-none opacity-60")}>
      <span className="min-w-0 break-words text-body font-medium">{name} is {on ? "on" : "off"}</span>
      <Switch on={on} onFlip={onFlip} />
    </label>
  );
}
