"use client";

import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
import { X, AlertCircle, Info } from "lucide-react";
import { useToasts, UNDO_MS, type Toast } from "@/lib/toast";
import { useMotionTokens } from "@/lib/motion";
import { Button } from "@/components/ui";

// Bottom-center toast stack for user-actionable failures. Auto-dismisses (store
// handles timing); click × or swipe it sideways to dismiss sooner. Mounted once
// in the root layout.
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="ol-toasts pointer-events-none fixed inset-x-0 bottom-6 z-toast flex flex-col items-center gap-2 px-4">
      <AnimatePresence initial={false}>
        {toasts.map((t) => <ToastCard key={t.id} t={t} />)}
      </AnimatePresence>
    </div>
  );
}

// Past either of these, a release throws the toast away instead of settling it back.
const SWIPE_PX = 80;
const FLICK_PX_S = 500;

function ToastCard({ t }: { t: Toast }) {
  const { dismiss, undo } = useToasts.getState();
  const { smooth, fade } = useMotionTokens();
  const x = useMotionValue(0);
  return (
    <motion.div role={t.kind === "error" ? "alert" : "status"} layout drag="x" style={{ x }} dragElastic={0.6}
      onDragEnd={(_, i) => {
        if (Math.abs(i.offset.x) > SWIPE_PX || Math.abs(i.velocity.x) > FLICK_PX_S) {
          // Thrown the way it was swiped, at the swipe's speed, fading as it goes.
          animate(x, Math.sign(i.offset.x || i.velocity.x) * window.innerWidth / 2, { ...smooth, velocity: i.velocity.x });
          dismiss(t.id);
        } else animate(x, 0, smooth);
      }}
      initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
      transition={{ ...smooth, opacity: fade }}
      className="pointer-events-auto relative flex max-w-md cursor-grab overflow-hidden touch-pan-y items-center gap-2.5 rounded-xl border border-hairline px-3.5 py-2.5 shadow-pop surface-float active:cursor-grabbing">
      {t.kind === "error"
        ? <AlertCircle className="size-4 shrink-0 text-danger" />
        : <Info className="size-4 shrink-0 text-accent" />}
      <p className="min-w-0 flex-1 break-words text-label leading-snug text-foreground">{t.text}</p>
      {t.undoable && (
        <Button variant="accent" size="sm" onClick={() => undo(t.id)}>
          Undo
        </Button>
      )}
      <Button variant="ghost" size="sm" icon onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <X />
      </Button>
      {t.undoable && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent/60 motion-reduce:hidden"
          style={{ animation: `toast-countdown ${UNDO_MS}ms linear forwards` }} />
      )}
    </motion.div>
  );
}
