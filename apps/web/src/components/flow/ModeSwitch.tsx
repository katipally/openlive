"use client";

import { useLayoutEffect, useRef } from "react";
import { Mic, MessageSquare, Waves } from "lucide-react";
import { cn } from "@/lib/cn";
import { MODE_LABEL, useUi, type AppMode } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { defaultPttKey } from "@openlive/flow-store/shared";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { keysListen, useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { hotkeyKeys, keyName, liveKeys, silenceLabel, type Talk } from "@/lib/dictate/hotkey";
import { Keycaps, Segmented } from "@/components/ui";

// The app-level switch, and what each mode is. Flow's and Dictate's keys stay
// armed in every mode, so this only changes what the window shows.
//
// It has exactly one home, top centre of the window in every mode, because a
// control that moves when you use it is a control you have to find again.

/** The one place each mode is described: the switch, Welcome, the homes, the
 *  tour, Settings and the palette all read these. How to start each is ModeStart. */
const COPY = {
  chat: {
    tagline: "A voice call with your AI.",
    body: "Talk back and forth with your API key's model or a coding agent like Claude Code. Share screen or camera, interrupt any time, resume later.",
  },
  flow: {
    tagline: "Ask your computer, from any app.",
    body: "Your AI listens, answers out loud, and can act for you: open apps, click, type, run commands. Thinks with your API key or a coding agent.",
  },
  dictate: {
    tagline: "Voice typing into any text box.",
    body: "Double-tap a key and talk: your words are typed at the cursor. Runs on this machine. No AI, nothing spoken back, unless you turn on AI polish or edit a selection by voice.",
  },
} as const satisfies Record<AppMode, { tagline: string; body: string }>;

export const MODES = ([
  { id: "chat" as const, label: MODE_LABEL.chat, icon: MessageSquare },
  { id: "flow" as const, label: MODE_LABEL.flow, icon: Waves },
  { id: "dictate" as const, label: MODE_LABEL.dictate, icon: Mic },
]).map((m) => ({ ...m, ...COPY[m.id], title: `${m.label}: ${COPY[m.id].tagline}` }));
export const modeCopy = (id: AppMode) => COPY[id];

/** Until Flow's settings are read: the default keys. */
const DEFAULT_TALK: Talk = { mode: "handsFree", pttKey: defaultPttKey(desktopPlatform), flowKey: "ctrl", dictateKey: "option", closeAfterSilenceMs: 30_000 };

const cap = (k: string) => <Keycaps keys={hotkeyKeys(k, desktopPlatform)} label={keyName(k, desktopPlatform)} className="align-middle" />;

/** How to start and close `mode`, with this person's keys and how they talk.
 *  `on`: whether Flow or Dictate is on already. */
export function ModeStart({ mode, on = false }: { mode: AppMode; on?: boolean }) {
  const talk = useFlowConfig().config?.talk ?? DEFAULT_TALK;
  const { caps } = useFlowCapabilities();
  const keys = liveKeys(talk);
  const ptt = talk.mode === "ptt";
  const silence = talk.closeAfterSilenceMs;
  const quiet = silence === null ? "" : ` It also closes after ${silenceLabel(silence)} of silence.`;
  if (mode === "chat") {
    if (!ptt) return <>Press New, then just talk.</>;
    // Only a key that would be heard is named; without one, the call's own button is the way.
    return isDesktop && keysListen(caps) ? <>Press New, then hold {cap(keys.ptt)} to talk.</> : <>Press New, then hold the Hold to talk button while you talk.</>;
  }
  if (mode === "flow") {
    return <>{on ? "Double-tap" : "Turn it on, double-tap"} {cap(keys.flow)} in any app, then {ptt ? <>hold {cap(keys.ptt)} to talk</> : "just talk"}. Double-tap again to close.{quiet}</>;
  }
  return (
    <>{on ? "Click" : "Turn it on, click"} into a text box, double-tap {cap(keys.dictate)} and {ptt ? <>hold {cap(keys.ptt)} while you talk</> : "talk"}. Double-tap again to stop.{quiet}</>
  );
}
/** `ModeStart` for Flow's and Dictate's homes: open, talk and close as three tiles, so
 *  no key ever sits in a sentence that wraps. Side by side when the room allows,
 *  stacked when it does not. Settings holds the rest (close after silence). */
export function ModeSteps({ mode, on = false }: { mode: "flow" | "dictate"; on?: boolean }) {
  const talk = useFlowConfig().config?.talk ?? DEFAULT_TALK;
  const keys = liveKeys(talk);
  const toggle = mode === "flow" ? keys.flow : keys.dictate;
  const ptt = talk.mode === "ptt";
  const steps = [
    { name: mode === "flow" ? "Open" : "Start", how: "Double-tap", cue: cap(toggle) },
    { name: "Talk", how: ptt ? "Hold" : "Hands free", cue: ptt ? cap(keys.ptt) : <Mic aria-hidden className="size-4 text-muted-foreground" /> },
    { name: mode === "flow" ? "Close" : "Stop", how: "Double-tap", cue: cap(toggle) },
  ];
  return (
    <div className="@container w-full max-w-[30rem]">
      {!on && <p className="sr-only">Turn it on first.</p>}
      <ol className={cn("grid list-none grid-cols-1 gap-2 transition-opacity @min-[24rem]:grid-cols-3", !on && "opacity-60")}>
        {steps.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised/40 px-3 py-2.5 text-left @min-[24rem]:flex-col @min-[24rem]:justify-center @min-[24rem]:gap-2 @min-[24rem]:text-center">
            <span className="flex flex-col">
              <span className="text-label font-medium text-foreground">{s.name}</span>
              <span className="text-caption text-faint">{s.how}</span>
            </span>
            {s.cue}
          </li>
        ))}
      </ol>
    </div>
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
