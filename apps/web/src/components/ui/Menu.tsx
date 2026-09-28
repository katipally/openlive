import type { RefObject } from "react";
import { Check } from "lucide-react";
import { useMenuPresence } from "@/lib/usePopIn";
import { useMenuKeys } from "@/lib/useMenuKeys";
import { groupLabel } from "./ListRow";

// The one look and the one behaviour for every popover menu and listbox: the
// surface, the item, the mark on the current choice, and useMenu for opening,
// closing and the keyboard. Item corners are concentric with the panel's: lg
// (12) minus the 6px padding is sm (6).

export const menuPanel = "rounded-lg border border-hairline bg-popover p-1.5 shadow-pop surface-blur";

export const menuItem = "flex min-h-8 w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition hover:bg-foreground/[0.06] disabled:opacity-40 disabled:hover:bg-transparent";

/** A small uppercase heading over a menu's items. */
export const menuLabel = `px-2.5 pb-1 pt-1 ${groupLabel}`;

export function MenuCheck() {
  return <Check aria-hidden className="size-3.5 shrink-0 text-accent" />;
}

/** A menu's whole life: it grows out of its trigger and back, focuses the
 *  current choice (or the first item), walks with the arrow keys, and closes on
 *  Esc, Tab or a press outside. `root` wraps the trigger (aria-haspopup) and the panel; render the
 *  panel on `mounted` with `panel` as its ref.
 *
 *    const m = useMenu(rootRef, panelRef);
 *    <button aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}>
 *    {m.mounted && <div ref={panelRef} role="menu">...</div>}
 */
export function useMenu(root: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>) {
  const menu = useMenuPresence(panel, root);
  useMenuKeys(root, menu.open, menu.requestClose);
  return menu;
}
