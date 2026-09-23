import { useEffect, useRef, type RefObject } from "react";

// Minimal modal a11y: while active, trap Tab inside the dialog, close on Escape,
// move focus in on open and restore it on close. Enough for our handful of
// modals without pulling in a focus-trap dependency.
const SEL = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose?: () => void) {
  // Callers pass a fresh closure every render. Held in a ref, so the trap runs
  // once per open and a re-render never pulls focus back to the first control.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>(SEL) ?? []).filter((n) => n.offsetParent !== null);
    (focusables()[0] ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      // An inner control (a dropdown, an inline rename) that handled Esc itself
      // marks it handled; the dialog closes only on an Esc nothing else claimed.
      if (e.key === "Escape") { if (!e.defaultPrevented) { e.preventDefault(); close.current?.(); } return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [active, ref]);
}
