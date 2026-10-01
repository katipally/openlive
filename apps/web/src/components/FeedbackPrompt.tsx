"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import type { FeedbackOffer } from "@openlive/shared";
import { Button } from "@/components/ui";
import { hideAfter, REASONS, SCALE, step, type Action, type Phase } from "@/lib/feedbackPrompt";
import { telemetry } from "@/lib/telemetry";
import { useMotionTokens } from "@/lib/motion";
import { isDesktop } from "@/lib/platform";
import { cn } from "@/lib/cn";

// How was that? A quiet card in the main window's corner, never a dialog: it takes no
// focus, blocks nothing and goes away by itself. The desktop app decides whether it may
// show at all (feedback.cjs: caps, back-off, "don't ask again"), so this only asks, shows
// what it was given and reports what the person did. It waits while the notice is owed or
// a call is open, and runs its timers only while the window is visible and not under the
// pointer or focus, and it announces itself politely. Focus is never taken; one that was
// moved into it comes back to where it was. A session rating follows a Flow session or a call; the 0 to 10
// question is the periodic one. The summary of a finished call reaches main within two
// seconds, so the first look waits three.
const CHECK_MS = 3_000;

export function FeedbackPrompt({ hold }: { hold: boolean }) {
  const [offer, setOffer] = useState<FeedbackOffer | null>(null);
  const [phase, setPhase] = useState<Phase>("ask");
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(true);
  const { smooth, fade } = useMotionTokens();
  const live = useRef<{ offer: FeedbackOffer | null; phase: Phase }>({ offer: null, phase: "ask" });
  const card = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<Element | null>(null);
  const engaged = hover || focused;

  const show = useCallback((o: FeedbackOffer | null, p: Phase) => {
    live.current = { offer: o, phase: p };
    setOffer(o);
    setPhase(p);
  }, []);

  const act = useCallback((action: Action) => {
    const { offer: o, phase: p } = live.current;
    if (!o) return;
    const next = step(p, action);
    if (next.answer) telemetry.feedbackAnswer(next.answer);
    show(next.phase ? o : null, next.phase ?? "ask");
  }, [show]);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    if (hold || !visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!live.current.offer) void telemetry.feedbackNext().then((o) => { if (o && !live.current.offer) show(o, "ask"); });
      }, CHECK_MS);
    };
    look();
    window.addEventListener("focus", look);
    return () => { clearTimeout(timer); window.removeEventListener("focus", look); };
  }, [hold, visible, show]);

  useEffect(() => { if (hold) act({ t: "leave" }); }, [hold, act]);
  useEffect(() => () => act({ t: "leave" }), [act]);

  // A node removed while it had focus fires no blur, and one removed under the pointer no pointerleave:
  // when a tap swaps the card's content or closes it, look at where focus is instead of trusting the events.
  useEffect(() => {
    const el = card.current;
    const inside = !!el && el.contains(document.activeElement);
    const dropped = !document.activeElement || document.activeElement === document.body;
    if (!offer) {
      setHover(false);
      setFocused(false);
      if (focused && dropped && cameFrom.current?.isConnected) (cameFrom.current as HTMLElement).focus?.({ preventScroll: true });
      cameFrom.current = null;
      return;
    }
    if (focused && dropped) el?.focus({ preventScroll: true });
    else setFocused(inside);
  }, [offer, phase]);

  useEffect(() => {
    if (!offer || (engaged && phase !== "thanks") || !visible) return;
    const timer = setTimeout(() => act({ t: "leave" }), hideAfter(offer, phase));
    return () => clearTimeout(timer);
  }, [offer, phase, engaged, visible, act]);

  const nps = offer?.kind === "nps";
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-banner flex justify-end">
      <AnimatePresence>
        {offer && (
          <motion.div key="feedback" ref={card} tabIndex={-1} role="region" aria-label="Feedback"
            onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
            onFocus={(e) => { if (!card.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget) cameFrom.current = e.relatedTarget as Element; setFocused(true); }}
            onBlur={(e) => { if (!card.current?.contains(e.relatedTarget as Node | null)) setFocused(false); }}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ ...smooth, opacity: fade }}
            className={cn("pointer-events-auto openlive-scroll flex max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border border-hairline p-4 text-left shadow-pop outline-none surface-float",
              isDesktop && "[-webkit-app-region:no-drag]")}>
            {phase === "thanks" ? (
              <p className="text-label text-muted-foreground">Thanks, that helps.</p>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="break-words text-body font-medium text-foreground">
                      {phase === "why" ? "What went wrong?" : nps ? "How likely are you to recommend OpenLive to a friend?" : "How was that?"}
                    </p>
                    {phase === "ask" && !nps && (
                      <p className="break-words text-label text-muted-foreground">{offer.surface === "flow" ? "Your last Flow session" : "Your last call"}</p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" icon aria-label="Dismiss" onClick={() => act({ t: "dismiss" })}><X /></Button>
                </div>
                {phase === "why" ? (
                  <div className="flex flex-wrap gap-2">
                    {REASONS.map((r) => <Button key={r.id} size="sm" onClick={() => act({ t: "reason", reason: r.id })}>{r.label}</Button>)}
                  </div>
                ) : nps ? (
                  <div className="flex flex-col gap-1.5">
                    <div role="group" aria-label="0 is not at all likely, 10 is very likely" className="flex flex-wrap gap-1.5">
                      {SCALE.map((n) => <Button key={n} icon size="sm" className="text-label" aria-label={String(n)} onClick={() => act({ t: "score", score: n })}>{n}</Button>)}
                    </div>
                    <div className="flex justify-between gap-3 text-caption text-faint"><span>Not likely</span><span>Very likely</span></div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => act({ t: "up" })}><ThumbsUp /> Good</Button>
                    <Button onClick={() => act({ t: "down" })}><ThumbsDown /> Not good</Button>
                  </div>
                )}
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => act({ t: "never" })}>Don&apos;t ask again</Button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
