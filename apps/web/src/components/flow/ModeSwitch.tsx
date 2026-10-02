"use client";

import { MessageSquare, Waves } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";

// The app-level switch. Chat is the OpenLive you already know; Flow is the same
// product with no window in the way. Flow's gesture stays armed in both, so this
// only changes what the window shows.
//
// It has exactly one home — top centre of the window, in both modes — because a
// control that moves when you use it is a control you have to find again.

const MODES = [
  { id: "chat" as const, label: "Chat", icon: MessageSquare, title: "Chat: talk in a call" },
  { id: "flow" as const, label: "Flow", icon: Waves, title: "Flow: talk from any app" },
];
// A narrow window keeps the icons and drops the words; the tooltips and the
// accessible names still say them.
const ICONS_WHEN_NARROW = "max-sm:[&_[role=radio]>span]:sr-only max-sm:[&_[role=radio]]:px-2";

export function ModeSwitch({ className }: { className?: string }) {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  return <Segmented options={MODES} value={mode} onChange={(m) => { if (m !== mode) featureUsed(m === "flow" ? "n_mode_to_flow" : "n_mode_to_chat"); setMode(m); }} label="What this window shows" className={cn(ICONS_WHEN_NARROW, className)} />;
}
