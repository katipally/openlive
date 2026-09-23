import { useEffect, useRef, type RefObject } from "react";

// The menu-button pattern for our small popup menus. `root` wraps the trigger
// (marked aria-haspopup) and the menu (items marked role=menuitem*). While open:
// the first item takes focus, Up/Down/Home/End move, Esc closes and hands focus
// back to the trigger, Tab closes and lets focus go on, and a press outside
// closes. Enter and Space are the items' own button behaviour.
const ITEMS = '[role^="menuitem"]:not([disabled])';

export function useMenuKeys(root: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const el = root.current;
    const items = () => Array.from(el?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const trigger = () => el?.querySelector<HTMLElement>("[aria-haspopup]");
    // The menu mounts a render after `open` flips (presence hooks), so wait a frame.
    const raf = requestAnimationFrame(() => items()[0]?.focus());

    const away = (e: PointerEvent) => { if (!el?.contains(e.target as Node)) close.current(); };
    // Capture, so an Esc meant for the menu is claimed before a surrounding
    // dialog's focus trap reads it as "close the dialog".
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); trigger()?.focus(); return; }
      if (!el?.contains(document.activeElement)) return;
      if (e.key === "Tab") { close.current(); return; }
      const list = items();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (at + 1) % list.length
        : e.key === "ArrowUp" ? (at <= 0 ? list.length - 1 : at - 1)
        : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      list[next]!.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey, true);
      // A pick unmounts the item that had focus; land back on the trigger, not the page.
      const f = document.activeElement;
      if (!f || f === document.body || (el?.contains(f) && f !== trigger())) trigger()?.focus();
    };
  }, [open, root]);
}
