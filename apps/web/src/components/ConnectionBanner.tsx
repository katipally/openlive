"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, WifiOff } from "lucide-react";
import { useLinkStatus } from "@/lib/live/linkStatus";
import { modelsCached } from "@/lib/live/models";
import { useMotionTokens } from "@/lib/motion";
import { isDesktop } from "@/lib/platform";
import { cn } from "@/lib/cn";

const BACK_MS = 2000;

const subscribeOnline = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => { window.removeEventListener("online", fn); window.removeEventListener("offline", fn); };
};

// Top-center pill for a lost connection. Shown only while this window actually
// wants one: a live socket is open or opening (the lobby pre-connecting a bound
// agent, or a call). A cold home screen or Flow's own page holds no socket here,
// so going offline there says nothing. Mounted by the main page only, never in
// the Flow orb window.
export function ConnectionBanner() {
  const { state, attempt, retry } = useLinkStatus();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const { spring, fade } = useMotionTokens();
  const expected = state !== "off";
  const offline = expected && !online;
  const reconnecting = expected && online && state === "reconnecting";
  const down = offline || reconnecting;

  // "Back online" only after an outage this banner showed, and only briefly.
  const [back, setBack] = useState(false);
  const wasDown = useRef(false);
  useEffect(() => {
    if (down) { wasDown.current = true; setBack(false); }
    else if (wasDown.current) { wasDown.current = false; setBack(expected); }
  }, [down, expected]);
  useEffect(() => {
    if (!back) return;
    const t = setTimeout(() => setBack(false), BACK_MS);
    return () => clearTimeout(t);
  }, [back]);

  const shown = offline ? "offline" : reconnecting ? "reconnecting" : back ? "back" : null;
  // Read when shown, not subscribed: the models do not come or go during an outage.
  const voiceLocal = offline && modelsCached();

  return (
    <div role="status" aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-[var(--z-banner)] flex justify-center px-4">
      <AnimatePresence>
        {shown && (
          <motion.div key="link" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ ...spring, opacity: fade }}
            className={cn("pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-full bg-card/95 py-1.5 pl-3 shadow-[var(--shadow-pop)] backdrop-blur",
              shown === "back" ? "pr-3" : "pr-1.5", isDesktop && "[-webkit-app-region:no-drag]")}>
            {shown === "offline" && <WifiOff className="size-3.5 shrink-0 text-arc" aria-hidden />}
            {shown === "reconnecting" && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}
            {shown === "back" && <Check className="size-3.5 shrink-0 text-success" aria-hidden />}
            <p className="min-w-0 break-words text-label text-foreground">
              <span className="font-medium">
                {shown === "offline" ? "You are offline" : shown === "reconnecting" ? "Reconnecting..." : "Back online"}
              </span>
              {shown === "reconnecting" && <span className="text-muted-foreground"> Try {Math.max(1, attempt)}. Your chat is safe.</span>}
              {voiceLocal && <span className="text-muted-foreground"> On-device voice still works.</span>}
            </p>
            {shown !== "back" && retry && (
              <button type="button" onClick={retry}
                className="shrink-0 rounded-full px-2.5 py-1 text-label font-medium text-accent transition hover:bg-accent/10 active:scale-[0.97] motion-reduce:active:scale-100">
                Retry now
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
