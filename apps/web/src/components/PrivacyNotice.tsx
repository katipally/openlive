"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, linkClass } from "@/components/ui";
import { noticeOwed } from "@/lib/privacyNotice";
import { telemetry } from "@/lib/telemetry";
import { EVENTS_URL, PRIVACY_URL } from "@/lib/repo";
import { useMotionTokens } from "@/lib/motion";
import { isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// The first-run note about anonymous usage data (D12). Nothing is sent until it
// has been on screen once, so a window that opens hidden (a login launch) waits
// for the first time it is actually seen. A card, not a toast: it stays until
// answered, takes no focus and blocks nothing. Mounted by the main page only.
// `onPending` tells the page while it is owed, so the home tour waits its turn.
export function PrivacyNotice({ onPending }: { onPending: (pending: boolean) => void }) {
  const [owed, setOwed] = useState(false);
  const [shown, setShown] = useState(false);
  const { smooth, fade } = useMotionTokens();

  useEffect(() => {
    let live = true;
    void noticeOwed().then((v) => { if (live) setOwed(v); });
    return () => { live = false; };
  }, []);
  useEffect(() => onPending(owed), [owed, onPending]);

  useEffect(() => {
    if (!owed || shown) return;
    const check = () => { if (document.visibilityState === "visible") setShown(true); };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [owed, shown]);
  useEffect(() => { if (shown) telemetry.noticeShown(); }, [shown]);

  const turnOff = () => {
    setOwed(false);
    void telemetry.set(false, "notice").then(() => toast("Usage sharing is off. You can turn it back on in Settings > Privacy.", "info"));
  };

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-banner flex">
      <AnimatePresence>
        {owed && shown && (
          <motion.div key="notice" role="region" aria-label="Anonymous usage data"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ ...smooth, opacity: fade }}
            className={cn("pointer-events-auto openlive-scroll flex max-h-[calc(100dvh-2rem)] min-w-0 max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border border-hairline p-4 text-left shadow-pop surface-float",
              isDesktop && "[-webkit-app-region:no-drag]")}>
            <div className="flex flex-col gap-1.5">
              <p className="text-body font-medium text-foreground">Anonymous usage data</p>
              <p className="break-words text-label leading-relaxed text-muted-foreground">
                OpenLive shares anonymous usage: which features get used, errors and speed. Never what you say or type, your files, names or keys.
                You can turn it off any time in Settings &gt; Privacy. Turning it off sends one last anonymous event saying so.
                Now and then it may also ask how a session went, with one tap to answer or say no.{" "}
                <a href={EVENTS_URL} target="_blank" rel="noreferrer" className={linkClass}>See every event</a>
                {" or "}
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className={linkClass}>read the privacy policy</a>
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={turnOff}>Turn off</Button>
              <Button variant="primary" size="sm" onClick={() => setOwed(false)}>Got it</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
