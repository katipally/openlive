"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animate } from "motion/react";
import { EXIT, FADE, POP, SMOOTH, popOrigin } from "@/lib/motion";

// Presence for popovers, menus and panels that render through a ref: the
// element pops in when it mounts and plays back out before it unmounts, on
// motion's springs (lib/motion.ts). Interruptible: reopening mid-exit reverses
// from wherever it got to, and only an exit that is still wanted unmounts.

type Pose = { x?: number; y?: number; scale?: number };
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Mount state plus both animations for `ref`. `closed` is the pose it leaves
 *  to and arrives from; `trigger` makes it grow out of that element instead. */
function usePose(ref: RefObject<HTMLElement | null>, open: boolean, closed: Pose, trigger?: () => HTMLElement | null) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const want = useRef(open);
  want.current = open;
  const busy = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!mounted || !el) return;
    let from: Pose = closed;
    if (trigger) {
      const o = popOrigin(el.getBoundingClientRect(), trigger()?.getBoundingClientRect() ?? null);
      el.style.transformOrigin = `${o.x}px ${o.below ? "0" : "100%"}`;
      from = { ...closed, y: (closed.y ?? 0) * (o.below ? -1 : 1) };
    }
    const reduce = reduced();
    const still = reduce ? {} : from;
    if (open) {
      // Fresh: from the closed pose, which the first frame already shows. Mid-exit:
      // on from wherever it got to, at its current speed.
      const to = reduce ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, scale: 1 };
      const keys = busy.current ? to : reduce ? { opacity: [0, 1] }
        : { opacity: [0, 1], x: [from.x ?? 0, 0], y: [from.y ?? 0, 0], scale: [from.scale ?? 1, 1] };
      busy.current = true;
      const run = animate(el, keys, reduce ? FADE : { ...SMOOTH, opacity: FADE });
      void Promise.resolve(run).then(() => { if (want.current) busy.current = false; });
      return;
    }
    busy.current = true;
    const run = animate(el, { opacity: 0, ...still }, EXIT);
    const done = () => { if (!want.current) { busy.current = false; setMounted(false); } };
    void Promise.resolve(run).then(done, done);
    // `closed` and `trigger` are read once per open or close, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  return mounted;
}

/** Pops `ref` in when `open` turns on (and on mount, if already open). */
export function usePopIn(ref: RefObject<HTMLElement | null>, open: boolean) {
  usePose(ref, open, POP);
}

/** A menu's presence, open state owned here. Render on `mounted`, key aria on
 *  `open`, dismiss through `requestClose` so open and close always mirror each
 *  other. `root` holds the trigger (its [aria-haspopup]) the menu grows from.
 *
 *    const m = useMenuPresence(menuRef, rootRef);
 *    <button aria-expanded={m.open} onClick={m.toggle}>…</button>
 *    {m.mounted && <div ref={menuRef}>…</div>}
 */
export function useMenuPresence(ref: RefObject<HTMLElement | null>, root?: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const mounted = usePose(ref, open, POP, () => root?.current?.querySelector<HTMLElement>("[aria-haspopup]") ?? null);
  const requestClose = () => setOpen(false);
  return { open, mounted, openMenu: () => setOpen(true), requestClose, toggle: () => setOpen((v) => !v) } as const;
}

/** Presence for a surface whose open state is owned elsewhere (a store flag or
 *  a prop). Fades by default; pass the closed pose for a slide or a scale.
 *
 *    const mounted = usePresence(ref, open, { x: 24 });
 *    {mounted && <div ref={ref}>…</div>}
 */
export function usePresence(ref: RefObject<HTMLElement | null>, open: boolean, closed: Pose = {}) {
  return usePose(ref, open, closed);
}
