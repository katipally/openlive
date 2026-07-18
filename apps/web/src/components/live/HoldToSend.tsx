"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveStore } from "@/lib/live/liveStore";
import { loadPipelineConfig } from "@/lib/live/pipelineConfig";
import { usePopIn } from "@/lib/usePopIn";
import { cn } from "@/lib/cn";

const R = 6.5;
const C = 2 * Math.PI * R;

/** Presentational "Waiting for you… tap to send" pill: a ring fills toward the
 *  auto-send moment; tapping commits the turn right away. Also used by the desktop
 *  mini panel, which gets `until`/`holdMs` over IPC instead of from the store. */
export function HoldPill({ until, holdMs, onSend, compact }: { until: number; holdMs: number; onSend: () => void; compact?: boolean }) {
  const [frac, setFrac] = useState(0);
  const ref = useRef<HTMLButtonElement>(null);
  usePopIn(ref, true); // pops on mount (the pill appears the moment a hold starts)

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const remaining = until - Date.now();
      setFrac(Math.min(1, Math.max(0, 1 - remaining / holdMs)));
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [until, holdMs]);

  return (
    <button ref={ref} onClick={onSend} title="Send now (Enter)" aria-label="Send now"
      className={cn("pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface text-muted-foreground transition hover:text-foreground",
        compact ? "px-2 py-0.5 text-caption" : "px-3 py-1 text-label")}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 8 8)" />
      </svg>
      {compact ? "Tap to send" : "Waiting for you… tap to send"}
    </button>
  );
}

/** Store-connected wrapper — visible while the engine holds a mid-thought pause
 *  (Smart-Turn said "not done" / the words trailed off). */
export function HoldToSend({ sendNow, compact }: { sendNow: () => void; compact?: boolean }) {
  const holdUntil = useLiveStore((s) => s.holdUntil);
  if (!holdUntil) return null;
  return <HoldPill until={holdUntil} holdMs={loadPipelineConfig().turn.holdMs} onSend={sendNow} compact={compact} />;
}
