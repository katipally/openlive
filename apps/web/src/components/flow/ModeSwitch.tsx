"use client";

import { useUi } from "@/lib/uiStore";
import { segBtn, segWrap } from "@/lib/seg";
import { cn } from "@/lib/cn";

// The app-level switch. Chat is the OpenLive you already know; Flow is the same
// product with no window in the way. Flow's key stays armed in both, so this
// only changes what the window shows.
export function ModeSwitch({ className }: { className?: string }) {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  return (
    <div className={cn(segWrap, className)} role="group" aria-label="What this window shows">
      <button type="button" onClick={() => setMode("chat")} aria-pressed={mode === "chat"} className={segBtn(mode === "chat")}>Chat</button>
      <button type="button" onClick={() => setMode("flow")} aria-pressed={mode === "flow"} className={segBtn(mode === "flow")}>Flow</button>
    </div>
  );
}
