"use client";

import { useRef, useSyncExternalStore } from "react";
import { Settings2, PanelLeft, Timer } from "lucide-react";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { AgentSelect } from "./AgentControls";
import { AgentBar, WorkspacePill } from "./AgentBar";
import { useUi } from "@/lib/uiStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, isWinDesktop } from "@/lib/platform";
import { perf } from "@/lib/live/perf";
import { useMenuPresence } from "@/lib/usePopIn";
import { useMenuKeys } from "@/lib/useMenuKeys";

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

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const STAGES = [
  ["sttEndpoint", "Speech-to-text + end of turn"], ["model", "Model, to first word"], ["tts", "Voice, to first sound"], ["voiceToVoice", "Voice to voice"],
] as const;

// The session's latency budget (lib/live/perf.ts): the chip is the median
// voice-to-voice time, the popover each stage's median and p95. Hidden until
// the first reply has played.
function LatencyChip() {
  const stats = useSyncExternalStore(perf.subscribe, perf.stats, () => null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenuPresence(panelRef);
  useMenuKeys(ref, open, requestClose);
  if (!stats) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={toggle} aria-haspopup="dialog" aria-expanded={open} title="Latency this session"
        className="flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-1 text-caption tabular-nums text-muted-foreground transition hover:text-foreground">
        <Timer className="size-3" /> {ms(stats.voiceToVoice.p50)}
      </button>
      {mounted && (
        <div ref={panelRef} role="dialog" aria-label="Latency this session"
          className="absolute right-0 z-50 mt-1.5 w-max max-w-[calc(100vw-2rem)] overflow-x-auto rounded-xl border border-border bg-popover p-3 shadow-xl">
          <table className="text-caption tabular-nums">
            <thead className="text-faint">
              <tr><th className="pb-1 pr-4 text-left font-medium">Stage</th><th className="pb-1 pl-2 text-right font-medium">Median</th><th className="pb-1 pl-2 text-right font-medium">p95</th></tr>
            </thead>
            <tbody>
              {STAGES.map(([k, label]) => (
                <tr key={k} className={k === "voiceToVoice" ? "font-semibold text-foreground" : "text-muted-foreground"}>
                  <td className="py-0.5 pr-4">{label}</td><td className="py-0.5 pl-2 text-right">{ms(stats[k].p50)}</td><td className="py-0.5 pl-2 text-right">{ms(stats[k].p95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-micro text-faint">Measured on this device over {stats.turns} {stats.turns === 1 ? "reply" : "replies"}.</p>
        </div>
      )}
    </div>
  );
}

// Running inside the desktop app? Then leave room for the custom window controls
// (top-left) and make the bar draggable (the window is frameless).
const noDrag = isDesktop ? "[-webkit-app-region:no-drag]" : "";

// The persistent in-call top bar: History toggle (left, opens the agent→workspace→
// session sidebar), logo, agent controls, settings (openable mid-call).
// Draggable in the desktop app; leaves room for the macOS traffic-light buttons.
export function TopBar() {
  const openSettings = useUi((s) => s.openSettings);
  const toggleHistory = useUi((s) => s.toggleHistory);

  return (
    // Three zones: [history + logo] · [centered agent cluster that grows outward] ·
    // [settings]. The 1fr side columns keep the middle cluster centered
    // (it expands symmetrically as more selectors appear); the empty side space is
    // the window drag handle.
    <header className={cn("grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center",
      isMacDesktop ? "pl-[84px]" : "pl-3",
      isWinDesktop ? "pr-[140px]" : "pr-3",
      isDesktop && "[-webkit-app-region:drag]")}>
      <div className="flex items-center gap-1 justify-self-start">
        <button onClick={toggleHistory} title="Sessions (H)" aria-label="Toggle sessions"
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
        <LatencyChip />
      </div>
      <div className={cn("flex items-center gap-1 justify-self-end", noDrag)}>
        <button onClick={openSettings} title="Settings" aria-label="Settings"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
      </div>
    </header>
  );
}
