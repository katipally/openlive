"use client";

import { useLayoutEffect, useRef } from "react";
import { Mic, MessageSquare, Waves } from "lucide-react";
import { MODE_LABEL, useUi, type AppMode } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { CONTROL } from "@/lib/platform";
import { Keycap, Keycaps, Segmented } from "@/components/ui";

// The app-level switch, and what each mode is. Flow's gesture
// and Dictate's key stay armed in every mode, so this only changes what the
// window shows.
//
// It has exactly one home, top centre of the window in every mode, because a
// control that moves when you use it is a control you have to find again.

/** The one place each mode is described: the switch, Welcome, the homes, the
 *  tour, Settings and the palette all read these. How to start each is ModeStart. */
const COPY = {
  chat: {
    tagline: "A voice call with your AI.",
    body: "Talk back and forth with your API model or a coding agent like Claude Code. Share screen or camera, interrupt any time, resume later.",
  },
  flow: {
    tagline: "Ask your computer, from any app.",
    body: "Your AI listens, answers out loud, and can act for you: open apps, click, type, run commands. Thinks with your API key or a coding agent.",
  },
  dictate: {
    tagline: "Voice typing into any text box.",
    body: "Hold a key, talk, let go: your words are typed at the cursor. Runs on this machine. No AI, nothing spoken back, unless you turn on AI polish.",
  },
} as const satisfies Record<AppMode, { tagline: string; body: string }>;

export const MODES = ([
  { id: "chat" as const, label: MODE_LABEL.chat, icon: MessageSquare },
  { id: "flow" as const, label: MODE_LABEL.flow, icon: Waves },
  { id: "dictate" as const, label: MODE_LABEL.dictate, icon: Mic },
]).map((m) => ({ ...m, ...COPY[m.id], title: `${m.label}: ${COPY[m.id].tagline}` }));
export const modeCopy = (id: AppMode) => COPY[id];

/** How to start `mode`, in this keyboard's key names. `hold` is Dictate's key, `on` whether Dictate is on already. */
export function ModeStart({ mode, hold = [], on = false }: { mode: AppMode; hold?: readonly string[]; on?: boolean }) {
  if (mode === "chat") return <>Press New, then talk.</>;
  if (mode === "flow") return <>Tap <Keycap className="text-label">{CONTROL}</Keycap> twice in any app. Tap twice again to close.</>;
  return (
    <>{on ? "Click" : "Turn it on, click"} into a text box, hold <Keycaps keys={hold} label={hold.join(" ")} className="align-middle" />, talk, let go. Double-tap for hands-free.</>
  );
}
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
