"use client";

import { useState } from "react";
import { X, Lightbulb, AlertCircle } from "lucide-react";
import { useLiveStore } from "@/lib/live/liveStore";
import { selectHints } from "@/lib/hints";
import { cn } from "@/lib/cn";

// Contextual hint chips above the dock: what you can say/do right now, and
// error recovery with a one-tap fix. At most two, quiet by design.
export function HintChips({ className }: { className?: string }) {
  const phase = useLiveStore((s) => s.phase);
  const active = useLiveStore((s) => s.active);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const agentMeta = useLiveStore((s) => s.agentMeta);
  const error = useLiveStore((s) => s.error);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const hints = selectHints({ phase, active, boundAgent, agentMeta, error }).filter((h) => !dismissed.includes(h.id));
  if (!hints.length) return null;

  return (
    <div className={cn("pointer-events-none flex flex-col items-center gap-1.5", className)}>
      {hints.map((h) => (
        <div key={h.id}
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full bg-card/90 py-1.5 pl-3 pr-1.5 shadow-[var(--shadow-card)] backdrop-blur animate-fade-up">
          {h.id.startsWith("err") ? <AlertCircle className="size-3.5 shrink-0 text-danger" /> : <Lightbulb className="size-3.5 shrink-0 text-accent" />}
          <span className="min-w-0 truncate text-[12px] text-foreground">{h.text}</span>
          {h.action && (
            <button onClick={h.action.run}
              className="shrink-0 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground transition hover:opacity-90">
              {h.action.label}
            </button>
          )}
          {h.dismissable && (
            <button aria-label="Dismiss hint"
              onClick={() => setDismissed((d) => [...d, h.id])}
              className="grid size-6 shrink-0 place-items-center rounded-full text-faint transition hover:bg-foreground/10 hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
