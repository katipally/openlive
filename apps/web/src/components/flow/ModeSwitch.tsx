"use client";

import { useLayoutEffect, useRef } from "react";
import { Mic, MessageSquare, Waves } from "lucide-react";
import { MODE_LABEL, useUi, type AppMode } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { Segmented } from "@/components/ui";

// The app-level switch. Chat is the OpenLive you already know; Flow is the same
// product with no window in the way; Dictate types what you say. Flow's gesture
// and Dictate's key stay armed in every mode, so this only changes what the
// window shows.
//
// It has exactly one home, top centre of the window in every mode, because a
// control that moves when you use it is a control you have to find again.

export const MODES = [
  { id: "chat" as const, label: MODE_LABEL.chat, icon: MessageSquare, title: "Chat: talk in a call" },
  { id: "flow" as const, label: MODE_LABEL.flow, icon: Waves, title: "Flow: talk from any app" },
  { id: "dictate" as const, label: MODE_LABEL.dictate, icon: Mic, title: "Dictate: type with your voice" },
];
/** The counter a switch to each mode counts, shared with the command palette. */
export const MODE_COUNTER = { chat: "n_mode_to_chat", flow: "n_mode_to_flow", dictate: "n_mode_to_dictate" } as const satisfies Record<AppMode, string>;
// A narrow window keeps the icons and drops the words; the tooltips and the
// accessible names still say them.
const ICONS_WHEN_NARROW = "max-sm:[&_[role=radio]>span]:sr-only max-sm:[&_[role=radio]]:px-2";

export function ModeSwitch({ className }: { className?: string }) {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const box = useRef<HTMLDivElement>(null);
  // Every drag bar under the switch cuts a hole this size (see SwitchHole), so a
  // longer label, another mode or the narrow icon-only form is never swallowed.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const root = document.documentElement.style;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      root.setProperty("--mode-switch-w", `${r.width}px`);
      root.setProperty("--mode-switch-bottom", `${r.bottom}px`);
    });
    ro.observe(el);
    return () => { ro.disconnect(); root.removeProperty("--mode-switch-w"); root.removeProperty("--mode-switch-bottom"); };
  }, []);
  // The wrapper is what the home tour points at; Segmented takes no data attributes.
  return (
    <div ref={box} className={className} data-tour="mode">
      <Segmented options={MODES} value={mode} onChange={(m) => { if (m !== mode) featureUsed(MODE_COUNTER[m]); setMode(m); }} label="What this window shows" className={ICONS_WHEN_NARROW} />
    </div>
  );
}

/**
 * The hole the mode switch sits in.
 *
 * Electron only subtracts a no-drag element from a drag region when it is a
 * DESCENDANT of it. The switch is neither: it floats over this bar from the
 * page, so its own no-drag counts for nothing here and every click on it was
 * being swallowed as a window drag. The bar reserves the space instead, as its
 * LAST child: the bar's other children inherit its drag, and a region later in
 * the page wins, so a title stretched under the switch would drag again.
 *
 * Window-centred rather than centred in this flex row, because that is where
 * the switch is, and every bar is padded unevenly for the traffic lights. Sized
 * from the switch's own measured box, above.
 */
export const SwitchHole = () => (
  <div aria-hidden className="fixed left-1/2 top-0 h-(--mode-switch-bottom) w-(--mode-switch-w) -translate-x-1/2 [-webkit-app-region:no-drag]" />
);
