"use client";

import { useEffect, useState, type RefObject } from "react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";

// Subtle enter for popovers/menus: fade + rise + a slight scale from the top edge.
// Targets the element directly (no selector), so no scope is needed; useGSAP
// reverts on unmount and re-runs when `open` flips.
export function usePopIn(ref: RefObject<HTMLElement | null>, open: boolean) {
  useGSAP(() => {
    if (!open || !ref.current || prefersReduced()) return;
    gsap.fromTo(ref.current, { autoAlpha: 0, y: -6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, transformOrigin: "top center", duration: DUR.fast, ease: EASE.out });
  }, { dependencies: [open] });
}

/** Menu presence: the pop-in played back on close, THEN unmount. Render on
 *  `mounted`, key aria on `open`, dismiss through `requestClose` so open and
 *  close always mirror each other (a menu that animates in but vanishes on
 *  close reads as broken).
 *
 *    const m = useMenuPresence(menuRef);
 *    <button aria-expanded={m.open} onClick={m.toggle}>…</button>
 *    {m.mounted && <div ref={menuRef}>…</div>}
 */
const EXIT_MS = DUR.fast * 1000;

export function useMenuPresence(ref: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { if (open) setMounted(true); }, [open]);

  // Enter through usePopIn (a proper useGSAP context that reverts on unmount).
  usePopIn(ref, open);

  // Exit with PLAIN gsap (not useGSAP): the context's revert-on-dep-change was
  // killing the exit tween before its onComplete, so the menu hung at opacity 0
  // forever. Unmount is driven by a timer matching the tween, so it fires even
  // if the tween is interrupted; a reopen (mounted flips before the timer) is
  // guarded by re-checking state.
  useEffect(() => {
    if (open || !mounted) return;
    const el = ref.current;
    if (!el || prefersReduced()) { setMounted(false); return; }
    gsap.to(el, { autoAlpha: 0, y: -6, scale: 0.97, duration: DUR.fast, ease: EASE.soft, overwrite: "auto" });
    const t = setTimeout(() => setMounted(false), EXIT_MS + 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  const requestClose = () => setOpen(false);
  return { open, mounted, openMenu: () => setOpen(true), requestClose, toggle: () => (open ? requestClose() : setOpen(true)) } as const;
}

/** Presence for a surface whose open/closed state is owned EXTERNALLY (a store
 *  flag or a prop — not an internal toggle like useMenuPresence). Renders while
 *  `mounted`, plays an enter on open and a REAL exit on close before unmounting,
 *  so modals and panels stop hard-cutting. Defaults to a plain fade; pass
 *  enter/exit vars for a slide/scale (transforms only — layout-safe).
 *
 *    const mounted = usePresence(ref, open);
 *    {mounted && <div ref={ref}>…</div>}
 */
export function usePresence(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  opts: { enter?: gsap.TweenVars; exit?: gsap.TweenVars; dur?: number; ease?: string } = {},
) {
  const [mounted, setMounted] = useState(open);
  const enter = opts.enter ?? { autoAlpha: 1 };
  const exit = opts.exit ?? { autoAlpha: 0 };
  useEffect(() => { if (open) setMounted(true); }, [open]);

  // Enter through a real useGSAP context (reverts cleanly on unmount).
  useGSAP(() => {
    if (!open || !ref.current || prefersReduced()) return;
    gsap.fromTo(ref.current, exit, { ...enter, duration: opts.dur ?? DUR.base, ease: opts.ease ?? EASE.settle });
  }, { dependencies: [open, mounted] });

  // Exit with plain gsap + a timer-driven unmount — same rationale as
  // useMenuPresence: useGSAP's revert-on-dep-change kills the exit tween early.
  useEffect(() => {
    if (open || !mounted) return;
    const el = ref.current;
    if (!el || prefersReduced()) { setMounted(false); return; }
    gsap.to(el, { ...exit, duration: DUR.fast, ease: EASE.soft, overwrite: "auto" });
    const t = setTimeout(() => setMounted(false), DUR.fast * 1000 + 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  return mounted;
}
