"use client";

import { Settings2, Minimize2, PanelLeft } from "lucide-react";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { AgentSelect } from "./AgentControls";
import { AgentBar } from "./AgentBar";
import { useUi } from "@/lib/uiStore";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/platform";

// Running inside the desktop app? Then leave room for the custom window controls
// (top-left) and make the bar draggable (the window is frameless).
const noDrag = isDesktop ? "[-webkit-app-region:no-drag]" : "";

// The persistent in-call top bar: History toggle (left, opens the agent→workspace→
// session sidebar), logo, agent controls, settings (openable mid-call), minimize.
// Draggable in the desktop app; leaves room for the macOS traffic-light buttons.
export function TopBar() {
  const openSettings = useUi((s) => s.openSettings);
  const setMinimized = useUi((s) => s.setMinimized);
  const toggleHistory = useUi((s) => s.toggleHistory);

  return (
    <header className={cn("flex h-12 shrink-0 items-center justify-between border-b border-border pr-3",
      isDesktop ? "pl-[80px]" : "pl-3",
      isDesktop && "[-webkit-app-region:drag]")}>
      <div className="flex items-center gap-1">
        <button onClick={toggleHistory} title="History" aria-label="Toggle history"
          className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", noDrag)}>
          <PanelLeft className="size-4" />
        </button>
        <div className="flex items-center gap-2 px-2">
          <OpenLiveOrb size={26} />
          <span className="text-[14px] font-semibold tracking-tight">OpenLive</span>
        </div>
        <AgentSelect />
        <AgentBar />
      </div>
      <div className={cn("flex items-center gap-1", noDrag)}>
        <button onClick={openSettings} title="Settings" aria-label="Settings"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
        <button onClick={() => setMinimized(true)} title="Minimize to floating bar" aria-label="Minimize"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Minimize2 className="size-4" /></button>
      </div>
    </header>
  );
}
