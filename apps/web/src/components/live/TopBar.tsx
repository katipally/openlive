"use client";

import { Settings2, Minimize2, PanelLeft } from "lucide-react";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { AgentSelect } from "./AgentControls";
import { AgentBar, WorkspacePill } from "./AgentBar";
import { useUi } from "@/lib/uiStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, isWinDesktop } from "@/lib/platform";

// Compact context/cost readout from the latest turn (ACP usage_update or the
// built-in brain's accounting). Hidden until the first turn reports. When the
// agent reports its window size, the chip becomes a real used/size meter.
function UsageChip() {
  const usage = useLiveStore((s) => s.usage);
  if (!usage || (!usage.contextTokens && !usage.outputTokens)) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const pct = usage.contextSize ? Math.min(100, Math.round((usage.contextTokens / usage.contextSize) * 100)) : null;
  return (
    <span title={pct != null ? `Context: ${k(usage.contextTokens)} of ${k(usage.contextSize!)} tokens used · cost so far` : "Context used this session · cost so far"}
      className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-caption tabular-nums text-muted-foreground">
      {pct != null && (
        <span className="relative h-1 w-8 overflow-hidden rounded-full bg-foreground/10">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", pct >= 90 ? "bg-destructive" : "bg-accent")} style={{ width: `${pct}%` }} />
        </span>
      )}
      {pct != null ? `${pct}%` : `${k(usage.contextTokens)} ctx`}{usage.costUsd > 0 && ` · $${usage.costUsd.toFixed(2)}`}
    </span>
  );
}

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
    // Three zones: [history + logo] · [centered agent cluster that grows outward] ·
    // [settings + minimize]. The 1fr side columns keep the middle cluster centered
    // (it expands symmetrically as more selectors appear); the empty side space is
    // the window drag handle.
    <header className={cn("grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center",
      isMacDesktop ? "pl-[84px]" : "pl-3",
      isWinDesktop ? "pr-[140px]" : "pr-3",
      isDesktop && "[-webkit-app-region:drag]")}>
      <div className="flex items-center gap-1 justify-self-start">
        <button onClick={toggleHistory} title="Sessions" aria-label="Toggle sessions"
          className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", noDrag)}>
          <PanelLeft className="size-4" />
        </button>
        <div className="flex items-center gap-2 px-2">
          <OpenLiveOrb size={26} />
          <span className="text-callout font-semibold tracking-tight">OpenLive</span>
        </div>
      </div>
      <div className={cn("flex items-center gap-1 justify-self-center", noDrag)}>
        <WorkspacePill />
        <AgentSelect />
        <AgentBar />
        <UsageChip />
      </div>
      <div className={cn("flex items-center gap-1 justify-self-end", noDrag)}>
        <button onClick={openSettings} title="Settings" aria-label="Settings"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
        <button onClick={() => setMinimized(true)} title="Minimize to floating bar" aria-label="Minimize"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Minimize2 className="size-4" /></button>
      </div>
    </header>
  );
}
