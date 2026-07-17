"use client";

import { X, AlertCircle, Info } from "lucide-react";
import { useToasts } from "@/lib/toast";
import { cn } from "@/lib/cn";

// Bottom-center toast stack for user-actionable failures. Auto-dismisses (store
// handles timing); click × to dismiss sooner. Mounted once in the root layout.
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} role="status"
          className="pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl bg-card/95 px-3.5 py-2.5 shadow-2xl backdrop-blur animate-[fade-up_0.25s_ease-out]">
          {t.kind === "error"
            ? <AlertCircle className="size-4 shrink-0 text-danger" />
            : <Info className="size-4 shrink-0 text-accent" />}
          <p className="min-w-0 flex-1 text-label leading-snug text-foreground">{t.text}</p>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss"
            className={cn("grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground")}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
