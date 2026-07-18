"use client";

import { Mic } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";

// A live "you're saying…" line for permission / elicitation modals. While a modal is
// open the user's spoken answer is captured for THAT modal (see useLiveSession /
// session.ts) — this surfaces the on-device transcription INSIDE the modal so the
// answer visibly lands here, not as a stray line in the background transcript.
export function ModalVoiceInput({ hint = "Say your answer…" }: { hint?: string }) {
  const { userCaption, userPartial, pttActive } = useLiveStore(useShallow((s) => ({
    userCaption: s.userCaption, userPartial: s.userPartial, pttActive: s.pttActive,
  })));
  const heard = userCaption.trim();
  const live = !!heard && userPartial;
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border bg-surface px-2.5 py-2 text-label transition",
      live ? "border-accent/60" : "border-border")} aria-live="polite">
      <Mic className={cn("size-3.5 shrink-0", live ? "text-accent" : "text-faint")} />
      <span className={cn("min-w-0 flex-1 truncate", heard ? "text-foreground" : "text-faint",
        live && "arc-shimmer")}>
        {heard || (pttActive ? "Listening — release to answer" : hint)}
      </span>
    </div>
  );
}
