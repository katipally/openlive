"use client";

import { useEffect, useRef, useState } from "react";
import { PhoneOff } from "lucide-react";
import { cn } from "@/lib/cn";

// The red hang-up, gated by a small "End call?" popover so a stray click doesn't
// drop a live call. Shared by the full-screen control bar and the floating mini
// pill. `interactive` marks the wrapper so the transparent overlay window in mini
// mode captures the pointer over it (see MiniBar).
export function EndCallButton({ onEnd, size = "size-9", interactive }: { onEnd: () => void; size?: string; interactive?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative" {...(interactive ? { "data-interactive": true } : {})}>
      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 w-44 -translate-x-1/2 rounded-xl border border-border bg-popover p-2 shadow-2xl">
          <p className="px-1 pb-2 pt-0.5 text-center text-label text-foreground">End call?</p>
          <div className="flex gap-1.5">
            <button onClick={() => setOpen(false)}
              className="flex-1 rounded-lg px-2 py-1.5 text-label text-muted-foreground transition hover:bg-foreground/10">Cancel</button>
            <button onClick={() => { setOpen(false); onEnd(); }}
              className="flex-1 rounded-lg bg-danger px-2 py-1.5 text-label font-medium text-white transition hover:opacity-90">End</button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} title="End call" aria-label="End call" aria-expanded={open}
        className={cn("grid place-items-center rounded-full bg-danger text-white transition hover:opacity-90 active:scale-95", size)}>
        <PhoneOff className="size-4" />
      </button>
    </div>
  );
}
