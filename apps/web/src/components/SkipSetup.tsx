"use client";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

/** Skip for a first run that never comes back: it asks first, the same way in
 *  Welcome, Flow's setup and Dictate's first run. Controlled, so Esc can ask too. */
export function SkipSetup({ asking, onAsk, onKeep, onSkip, className }: {
  asking: boolean; onAsk: () => void; onKeep: () => void; onSkip: () => void; className?: string;
}) {
  if (!asking) return <Button variant="ghost" size="sm" onClick={onAsk} className={className}>Skip</Button>;
  return (
    <span role="group" aria-label="Skip setup?" className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}>
      <span aria-live="polite" className="whitespace-nowrap text-label text-muted-strong">Skip setup?</span>
      <Button variant="ghost" size="sm" autoFocus onClick={onKeep}>Keep going</Button>
      <Button variant="secondary" size="sm" onClick={onSkip}>Skip</Button>
    </span>
  );
}
