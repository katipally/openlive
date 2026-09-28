"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { isTruncated } from "@/lib/truncated";
import { keyboardFocused } from "./focus";

// A short explanation on hover (after a beat) or on keyboard focus (at once),
// never on focus a script moved (a dialog opening).
// Portalled and fixed, so no scroll container or overflow clips it; placed
// above the trigger, or below when there is no room, and kept inside the
// window at any width. It closes on scroll, resize and Escape rather than
// chasing a moving trigger, and on a press, so it never sits over what the
// press opens. `keys` adds the shortcut hint; `truncated` shows the label only
// while its text is cut off: the [data-truncates] element inside, else the first child.
// An empty label shows nothing, so a conditional tip needs no second branch.
//
// A disabled <button> gets no pointer events in every engine, so a control
// that explains why it is unavailable should use aria-disabled instead.

const DELAY_MS = 600;
const GAP = 6;
const EDGE = 8;
// Once one tooltip has shown, the next within this long shows at once, so
// running the pointer along a row of controls reads each without the wait.
const WARM_MS = 400;
let lastHidden = 0;

export function Tooltip({ label, keys, truncated, children, className }: {
  label: ReactNode; keys?: string; truncated?: boolean; children: ReactNode; className?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const show = (now = false) => {
    clearTimeout(timer.current);
    if (!label) return;
    const text = anchor.current?.querySelector("[data-truncates]") ?? anchor.current?.firstElementChild;
    if (truncated && (!text || !isTruncated(text))) return;
    if (now || performance.now() - lastHidden < WARM_MS) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (open) lastHidden = performance.now();
    setOpen(false);
    setPos(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const a = anchor.current?.getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    if (!a || !t) return;
    const room = document.documentElement.clientWidth - EDGE - t.width;
    const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - t.width / 2, room));
    const above = a.top - GAP - t.height;
    setPos(above >= EDGE ? { left, top: above, below: false } : { left, top: a.bottom + GAP, below: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The description belongs on the control itself, which is what a screen reader lands on.
    const target = anchor.current?.querySelector<HTMLElement>("button, a, input, select, textarea, [tabindex]");
    const before = target?.getAttribute("aria-describedby");
    target?.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      if (before) target?.setAttribute("aria-describedby", before);
      else target?.removeAttribute("aria-describedby");
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, id]);

  return (
    <span ref={anchor} className={cn("inline-flex", className)}
      onPointerEnter={() => show()} onPointerLeave={hide} onPointerDown={hide}
      onFocus={(e) => keyboardFocused(e.target) && show(true)} onBlur={hide}>
      {children}
      {open && createPortal(
        <span ref={tip} id={id} role="tooltip"
          style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.below ? "top" : "bottom" } : { left: 0, top: 0, visibility: "hidden" }}
          className={cn("pointer-events-none fixed z-toast w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-sm bg-tooltip px-2.5 py-1 text-label text-tooltip-foreground shadow-pop", pos && "ol-tip-in")}>
          {label}
          {keys && <kbd className="ml-1.5 font-mono opacity-60">{keys}</kbd>}
        </span>,
        document.body,
      )}
    </span>
  );
}
