"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, Lightbulb, AlertCircle } from "lucide-react";
import { useLiveStore } from "@/lib/live/liveStore";
import { selectHints } from "@/lib/hints";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";
import { useMotionTokens } from "@/lib/motion";

// Contextual hint chips above the dock: what you can say/do right now, and
// error recovery with a one-tap fix. At most two, quiet by design.
export function HintChips({ className }: { className?: string }) {
  const phase = useLiveStore((s) => s.phase);
  const active = useLiveStore((s) => s.active);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const agentMeta = useLiveStore((s) => s.agentMeta);
  const error = useLiveStore((s) => s.error);
  const errorCode = useLiveStore((s) => s.errorCode);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const { smooth, fade, exit: leave } = useMotionTokens();

  const hints = selectHints({ phase, active, boundAgent, agentMeta, error, errorCode }).filter((h) => !dismissed.includes(h.id));
  return (
    <div className={cn("pointer-events-none flex flex-col items-center gap-1.5", className)}>
      <AnimatePresence initial={false}>
      {hints.map((h) => (
        <motion.div key={h.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, transition: leave }}
          transition={{ ...smooth, opacity: fade }}
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 shadow-card surface-float">
          {h.id.startsWith("err") ? <AlertCircle className="size-3.5 shrink-0 text-danger" /> : <Lightbulb className="size-3.5 shrink-0 text-accent" />}
          <span className="min-w-0 truncate text-label text-foreground">{h.text}</span>
          {h.action && (
            <Button variant="primary" size="sm" onClick={h.action.run}>
              {h.action.label}
            </Button>
          )}
          {h.dismissable && (
            <Button variant="ghost" size="sm" icon aria-label="Dismiss hint" onClick={() => setDismissed((d) => [...d, h.id])}>
              <X />
            </Button>
          )}
        </motion.div>
      ))}
      </AnimatePresence>
    </div>
  );
}
