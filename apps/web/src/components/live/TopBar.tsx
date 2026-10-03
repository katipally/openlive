"use client";

import { useRef, useSyncExternalStore } from "react";
import { Settings2, PanelLeft, Timer } from "lucide-react";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { AgentSelect } from "./AgentControls";
import { AgentBar, ApiBar, WorkspacePill } from "./AgentBar";
import { pill, Tooltip, menuPanel, useMenu, Button } from "@/components/ui";
import { useUi } from "@/lib/uiStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, isNonMacDesktop, SETTINGS_KEYS } from "@/lib/platform";
import { perf } from "@/lib/live/perf";

// Compact context/cost readout from the latest turn (ACP usage_update or the
// built-in brain's accounting). Hidden until the first turn reports. When the
// agent reports its window size, the chip becomes a real used/size meter.
function UsageChip() {
  const usage = useLiveStore((s) => s.usage);
  if (!usage || (!usage.contextTokens && !usage.outputTokens)) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const pct = usage.contextSize ? Math.min(100, Math.round((usage.contextTokens / usage.contextSize) * 100)) : null;
  return (
    <Tooltip label={pct != null ? `Context: ${k(usage.contextTokens)} of ${k(usage.contextSize!)} tokens used · cost so far` : "Context used this session · cost so far"} className="shrink-0">
      <span className={cn(pill, "font-mono text-caption font-normal tabular-nums text-muted-strong")}>
        {pct != null && (
          <span className="relative h-1 w-8 overflow-hidden rounded-full bg-foreground/10">
            <span className={cn("absolute inset-0 origin-left rounded-full transition-transform duration-slow ease-out-quart", pct >= 90 ? "bg-destructive" : "bg-accent")}
              style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
        )}
        {/* Each figure rolls in when it changes, the rest of the line holds still. */}
        <Tick value={pct != null ? `${pct}%` : `${k(usage.contextTokens)} ctx`} />
        {usage.costUsd > 0 && <> · <Tick value={`$${usage.costUsd.toFixed(2)}`} /></>}
      </span>
    </Tooltip>
  );
}

/** A figure that rolls up into place when it changes (keyed, so the CSS replays). */
const Tick = ({ value }: { value: string }) => <span key={value} className="ol-tick">{value}</span>;

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
  const { open, mounted, toggle } = useMenu(ref, panelRef);
  if (!stats) return null;
  return (
    <div ref={ref} className="relative">
      <Tooltip label="Latency this session">
        <button onClick={toggle} aria-haspopup="dialog" aria-expanded={open} aria-label={`Voice to voice ${ms(stats.voiceToVoice.p50)}, latency this session`}
          className={cn(pill, "shrink-0 font-mono text-caption font-normal tabular-nums text-muted-strong hover:text-foreground")}>
          <Timer aria-hidden className="size-3 text-muted-foreground" /> <Tick value={ms(stats.voiceToVoice.p50)} />
        </button>
      </Tooltip>
      {mounted && (
        <div ref={panelRef} role="dialog" aria-label="Latency this session"
          className={cn("absolute right-0 z-overlay mt-1.5 w-max max-w-[calc(100vw-2rem)] overflow-x-auto p-3", menuPanel)}>
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
    <header className={cn("grid h-12 shrink-0 grid-cols-[minmax(min-content,1fr)_minmax(0,auto)_minmax(min-content,1fr)] items-center gap-2",
      isMacDesktop ? "pl-traffic-lights" : "pl-3",
      isNonMacDesktop ? "pr-window-controls" : "pr-3",
      isDesktop && "[-webkit-app-region:drag]")}>
      <div className="flex min-w-0 items-center gap-1">
        <Tooltip label="History" keys="H" className={noDrag}>
          <Button variant="ghost" icon size="sm" onClick={toggleHistory} aria-label="Toggle history">
            <PanelLeft />
          </Button>
        </Tooltip>
        <div className="flex min-w-0 items-center gap-2 px-2">
          <OpenLiveOrb size={26} />
          <span className="truncate text-callout font-semibold tracking-tight">OpenLive</span>
        </div>
      </div>
      <div className={cn("flex min-w-0 items-center justify-center gap-1.5", noDrag)}>
        <WorkspacePill />
        <div className="min-w-0"><AgentSelect /></div>
        <AgentBar />
        <ApiBar />
        <UsageChip />
        <LatencyChip />
      </div>
      <div className={cn("flex items-center gap-1 justify-self-end", noDrag)}>
        <Tooltip label="Settings" keys={SETTINGS_KEYS}><Button variant="ghost" icon size="sm" onClick={openSettings} aria-label="Settings"><Settings2 /></Button></Tooltip>
      </div>
    </header>
  );
}
