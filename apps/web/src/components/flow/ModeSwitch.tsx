"use client";

import { Mic, MessageSquare, Waves } from "lucide-react";
import { useUi, type AppMode } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { Segmented } from "@/components/ui";

// The app-level switch. Chat is the OpenLive you already know; Flow is the same
// product with no window in the way; Dictate types what you say. Flow's gesture
// and Dictate's key stay armed in every mode, so this only changes what the
// window shows.
//
// It has exactly one home — top centre of the window, in every mode — because a
// control that moves when you use it is a control you have to find again.

export const MODES = [
  { id: "chat" as const, label: "Chat", icon: MessageSquare, title: "Chat: talk in a call" },
  { id: "flow" as const, label: "Flow", icon: Waves, title: "Flow: talk from any app" },
  { id: "dictate" as const, label: "Dictate", icon: Mic, title: "Dictate: type with your voice" },
];
/** The counter a switch to each mode counts, shared with the command palette. */
export const MODE_COUNTER = { chat: "n_mode_to_chat", flow: "n_mode_to_flow", dictate: "n_mode_to_dictate" } as const satisfies Record<AppMode, string>;
// A narrow window keeps the icons and drops the words; the tooltips and the
// accessible names still say them.
const ICONS_WHEN_NARROW = "max-sm:[&_[role=radio]>span]:sr-only max-sm:[&_[role=radio]]:px-2";

export function ModeSwitch({ className }: { className?: string }) {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  // The wrapper is what the home tour points at; Segmented takes no data attributes.
  return (
    <div className={className} data-tour="mode">
      <Segmented options={MODES} value={mode} onChange={(m) => { if (m !== mode) featureUsed(MODE_COUNTER[m]); setMode(m); }} label="What this window shows" className={ICONS_WHEN_NARROW} />
    </div>
  );
}
