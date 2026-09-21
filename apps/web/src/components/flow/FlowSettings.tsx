"use client";

import { useRef, useState } from "react";
import { MonitorSpeaker, Mic, Moon } from "lucide-react";
import type { ActivationMode, InsertionMethod } from "@openlive/flow-store";
import { useUi } from "@/lib/uiStore";
import { loadPipelineConfig, savePipelineConfig } from "@/lib/live/pipelineConfig";
import { cn } from "@/lib/cn";
import { segBtn, segWrap } from "@/lib/seg";
import { useFlowConfig, type FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { BindingField } from "./BindingField";
import { BrainPicker } from "./BrainPicker";
import { CapabilityPanel } from "./CapabilityPanel";
import { RiskTiers } from "./RiskTiers";

// Everything Flow can be configured with, on one surface. Every control writes
// straight through to the store, and what comes back from the write is what the
// screen then shows: the parse is the authority, so a clamped value is visible
// rather than silently different from what was clicked.

const ACTIVATION: { id: ActivationMode; label: string }[] = [
  { id: "hold_or_toggle", label: "Hold to talk" },
  { id: "toggle", label: "Tap to toggle" },
  { id: "ptt", label: "Push to talk" },
];

const IDLE_CHOICES = [
  { ms: 90_000, label: "90 seconds after the last reply" },
  { ms: 300_000, label: "5 minutes after the last reply" },
  { ms: 1_800_000, label: "30 minutes after the last reply" },
];

const SECTIONS = [
  { id: "trigger", label: "Trigger" },
  { id: "brain", label: "Brain" },
  { id: "voice", label: "Voice and quiet" },
  { id: "typing", label: "How it types" },
  { id: "risk", label: "What it may do" },
  { id: "machine", label: "This machine" },
] as const;

export function FlowSettings() {
  const { config, save, error } = useFlowConfig();
  const { caps, error: capsError, refresh } = useFlowCapabilities();
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const body = useRef<HTMLDivElement>(null);

  const goTo = (id: string) => body.current?.querySelector(`#flow-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!config) {
    return <p className="m-auto px-6 text-body text-muted-strong">{error || "Reading Flow's settings…"}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-wrap gap-6 px-6 pb-8">
      <nav aria-label="Flow settings sections" className="flex min-w-[10rem] flex-[0_1_13rem] flex-col gap-1 self-start">
        <span className="px-3 pb-1 pt-2 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">Flow</span>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => goTo(s.id)}
            className="rounded-md px-3 py-2.5 text-left text-body text-muted-strong transition hover:bg-foreground/[0.05] hover:text-foreground">
            {s.label}
          </button>
        ))}
        <span className="px-3 pb-1 pt-4 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">OpenLive</span>
        <button type="button" onClick={() => openSettingsTab("models")}
          className="rounded-md px-3 py-2.5 text-left text-body text-muted-strong transition hover:bg-foreground/[0.05] hover:text-foreground">
          Providers and keys
        </button>
        <button type="button" onClick={() => openSettingsTab("general")}
          className="rounded-md px-3 py-2.5 text-left text-body text-muted-strong transition hover:bg-foreground/[0.05] hover:text-foreground">
          Appearance
        </button>
      </nav>

      <div ref={body} className="openlive-scroll flex min-w-[20rem] flex-[1_1_30rem] flex-col gap-8 overflow-y-auto pb-4 pr-1">
        {error && <p className="rounded-lg bg-card px-4 py-3 text-label text-destructive-text shadow-[var(--shadow-xs)]">{error}</p>}

        <Section id="trigger" title="Trigger" desc="The one key that opens Flow, anywhere on this machine.">
          <BindingField binding={config.binding} onSave={(binding) => save({ binding })} />
          <Range label="Hold before it opens" min={120} max={600} step={10} value={config.holdThresholdMs}
            format={(v) => `${v} ms`} onChange={(holdThresholdMs) => save({ holdThresholdMs })} />
          <p className="text-caption leading-relaxed text-muted-strong">
            Below that it stays an ordinary modifier, and holding it with any other key never opens Flow.
          </p>
          <Seg label="Activation" options={ACTIVATION} value={config.activation} onChange={(activation) => save({ activation })} />
          <label className="flex flex-wrap items-center gap-2.5">
            <span className="shrink-0 text-label text-muted-strong">Keep the conversation going for</span>
            <select className="ol-select h-9 min-w-0 flex-1 rounded-md bg-card px-2.5 text-label shadow-[var(--shadow-xs)] outline-none"
              value={IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) ? String(config.idleWindowMs) : "custom"}
              onChange={(e) => e.target.value !== "custom" && save({ idleWindowMs: Number(e.target.value) })}>
              {!IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) && (
                <option value="custom">{Math.round(config.idleWindowMs / 1000)} seconds after the last reply</option>
              )}
              {IDLE_CHOICES.map((c) => <option key={c.ms} value={c.ms}>{c.label}</option>)}
            </select>
          </label>
        </Section>

        <Section id="brain" title="Brain" desc="Who does the thinking. Swapping it keeps every other setting.">
          <BrainPicker config={config} save={save} compact />
        </Section>

        <Section id="voice" title="Voice and quiet" desc="Flow speaks every reply, and goes quiet on its own when speaking out loud would be wrong.">
          <div className="flex flex-col gap-4 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
            <Switch on={config.voice.speakReplies} onFlip={(speakReplies) => save({ voice: { speakReplies } })}
              label="Say replies out loud" note="With this off, every reply is written on the pill instead." />
            <Switch on={config.voice.bargeIn} onFlip={(bargeIn) => save({ voice: { bargeIn } })}
              label="Let me talk over it" note="Start talking and Flow stops mid-sentence. Only what it actually said is kept." />
            <SpeakingPace />
          </div>

          <div className="flex flex-col rounded-lg bg-card p-1.5 shadow-[var(--shadow-card)]">
            <Quiet icon={MonitorSpeaker} label="A meeting app is in front" first
              on={config.voice.autoQuiet.meetingApps} onFlip={(meetingApps) => save({ voice: { autoQuiet: { ...config.voice.autoQuiet, meetingApps } } })} />
            <Quiet icon={Mic} label="Another app is holding the mic"
              on={config.voice.autoQuiet.micContention} onFlip={(micContention) => save({ voice: { autoQuiet: { ...config.voice.autoQuiet, micContention } } })} />
            <Quiet icon={Moon} label="Do Not Disturb is on"
              on={config.voice.autoQuiet.systemDnd} onFlip={(systemDnd) => save({ voice: { autoQuiet: { ...config.voice.autoQuiet, systemDnd } } })} />
          </div>
          <p className="text-caption leading-relaxed text-muted-strong">
            Any of these falls back to text for that turn and keeps working. The speaker button on the pill overrides all
            of them, in both directions, for the rest of the session.
          </p>
        </Section>

        <Section id="typing" title="How it types" desc="Flow can paste, which is instant, or type character by character, which some apps prefer.">
          <Seg label="Method" value={config.insertion.method}
            options={[{ id: "paste" as InsertionMethod, label: "Paste" }, { id: "type" as InsertionMethod, label: "Type it out" }]}
            onChange={(method) => save({ insertion: { method } })} />
          <div className={cn("flex flex-col gap-4 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]",
            config.insertion.method !== "paste" && "opacity-60")}>
            <Range label="Hold the modifier for" min={0} max={300} step={10} value={config.insertion.modifierHoldMs}
              format={(v) => `${v} ms`} onChange={(modifierHoldMs) => save({ insertion: { modifierHoldMs } })} />
            <Range label="Wait before putting the clipboard back" min={0} max={1000} step={25} value={config.insertion.clipboardQuietMs}
              format={(v) => `${v} ms`} onChange={(clipboardQuietMs) => save({ insertion: { clipboardQuietMs } })} />
            <Range label="Give up waiting after" min={1000} max={20_000} step={500} value={config.insertion.clipboardTimeoutMs}
              format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(clipboardTimeoutMs) => save({ insertion: { clipboardTimeoutMs } })} />
            <p className="text-caption leading-relaxed text-muted-strong">
              {config.insertion.method === "paste"
                ? "Your clipboard goes back the moment the other app has actually read it, and it goes back even if the paste fails. Anything you copy yourself wins."
                : "These only apply to pasting."}
            </p>
          </div>
        </Section>

        <Section id="risk" title="What it may do without asking" desc="Risk is data, not a rule engine. Set a tier, or one tool.">
          <RiskTiers config={config} save={save} />
        </Section>

        <Section id="machine" title="What this machine can do" desc="Read from the desktop, not assumed from the platform.">
          <CapabilityPanel caps={caps} error={capsError} onRecheck={refresh} />
        </Section>
      </div>
    </div>
  );
}

/**
 * Flow and live calls speak with one voice at one pace, so this writes the
 * pipeline config the voice stack actually reads per sentence rather than a
 * second copy of the number that nothing would consult.
 */
function SpeakingPace() {
  const [speed, setSpeed] = useState(() => loadPipelineConfig().tts.speed);
  const set = (v: number) => {
    const cfg = loadPipelineConfig();
    setSpeed(savePipelineConfig({ ...cfg, tts: { ...cfg.tts, speed: v } }).tts.speed);
  };
  return <Range label="Speaking pace, here and in calls" min={0.5} max={2} step={0.05} value={speed}
    format={(v) => `${v.toFixed(2)}x`} onChange={set} />;
}

function Section({ id, title, desc, children }: { id: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section id={`flow-${id}`} className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        <p className="max-w-[44rem] text-label leading-relaxed text-muted-strong">{desc}</p>
      </div>
      {children}
    </section>
  );
}

function Seg<T extends string>({ label, options, value, onChange }: {
  label: string; options: { id: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className={cn(segWrap, "self-start")} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id} className={segBtn(value === o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Range({ label, min, max, step, value, format, onChange }: {
  label: string; min: number; max: number; step: number; value: number; format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-[12rem] flex-1 text-label text-muted-strong">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 min-w-[8rem] flex-[2] cursor-pointer appearance-none rounded-full bg-border accent-[var(--accent)]" />
      <span className="w-[4.5rem] shrink-0 text-right font-mono text-label tabular-nums">{format(value)}</span>
    </label>
  );
}

function Switch({ on, onFlip, label, note }: { on: boolean; onFlip: (v: boolean) => void; label: string; note: string }) {
  return (
    <label className="flex cursor-pointer select-none items-start gap-3">
      <button type="button" role="switch" aria-checked={on} onClick={() => onFlip(!on)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="min-w-0 text-label leading-snug text-foreground">
        {label}
        <span className="block text-caption leading-relaxed text-muted-strong">{note}</span>
      </span>
    </label>
  );
}

function Quiet({ icon: Icon, label, on, onFlip, first }: {
  icon: typeof Mic; label: string; on: boolean; onFlip: (v: boolean) => void; first?: boolean;
}) {
  return (
    <label className={cn("flex min-h-12 cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2",
      !first && "shadow-[inset_0_1px_0_var(--border)]")}>
      <Icon className="size-[17px] shrink-0 text-muted-strong" aria-hidden />
      <span className="min-w-0 flex-1 text-body">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onFlip(!on)}
        className={cn("relative h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
    </label>
  );
}
