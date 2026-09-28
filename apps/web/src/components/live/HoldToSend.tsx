"use client";

import { useEffect, useRef } from "react";
import { useLiveStore } from "@/lib/live/liveStore";
import { loadPipelineConfig } from "@/lib/live/pipelineConfig";
import { usePopIn } from "@/lib/usePopIn";
import { cn } from "@/lib/cn";
import { Button, Tooltip } from "@/components/ui";

const R = 6.5;
const C = 2 * Math.PI * R;

/** Presentational "Waiting for you… tap to send" pill: a ring fills toward the
 *  auto-send moment; tapping commits the turn right away. */
export function HoldPill({ until, holdMs, onSend, compact }: { until: number; holdMs: number; onSend: () => void; compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  usePopIn(ref, true); // pops on mount (the pill appears the moment a hold starts)

  // The ring fills on the compositor's clock, not React's: no render per frame.
  useEffect(() => {
    const remaining = Math.max(0, until - Date.now());
    const frac = holdMs > 0 ? Math.min(1, 1 - remaining / holdMs) : 1;
    const run = ring.current?.animate([{ strokeDashoffset: C * (1 - frac) }, { strokeDashoffset: 0 }], { duration: remaining, fill: "forwards" });
    return () => run?.cancel();
  }, [until, holdMs]);

  return (
    <Tooltip label="Send now" keys="Enter">
      <Button ref={ref} size="sm" onClick={onSend} aria-label="Send now"
        className={cn("pointer-events-auto text-muted-foreground enabled:hover:text-foreground", compact && "h-6 px-2 text-caption")}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
          <circle ref={ring} cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C} transform="rotate(-90 8 8)" />
        </svg>
        {compact ? "Tap to send" : "Waiting for you… tap to send"}
      </Button>
    </Tooltip>
  );
}

/** Store-connected wrapper — visible while the engine holds a mid-thought pause
 *  (Smart-Turn said "not done" / the words trailed off). */
export function HoldToSend({ sendNow, compact }: { sendNow: () => void; compact?: boolean }) {
  const holdUntil = useLiveStore((s) => s.holdUntil);
  if (!holdUntil) return null;
  return <HoldPill until={holdUntil} holdMs={loadPipelineConfig().turn.holdMs} onSend={sendNow} compact={compact} />;
}
