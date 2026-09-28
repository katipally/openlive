"use client";

import { MessageSquare, Waves } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { Segmented } from "@/components/ui";

// The app-level switch. Chat is the OpenLive you already know; Flow is the same
// product with no window in the way. Flow's gesture stays armed in both, so this
// only changes what the window shows.
//
// It has exactly one home — top centre of the window, in both modes — because a
// control that moves when you use it is a control you have to find again.

const MODES = [
  { id: "chat" as const, label: "Chat", icon: MessageSquare },
  { id: "flow" as const, label: "Flow", icon: Waves },
];

export function ModeSwitch({ className }: { className?: string }) {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  return <Segmented options={MODES} value={mode} onChange={setMode} label="What this window shows" className={className} />;
}
