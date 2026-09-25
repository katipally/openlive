"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowConfig, InsertionMethod } from "@openlive/flow-store";
import { CONTROL, isDesktop, isMac } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { Keycap } from "@/components/Keycap";
import { Switch } from "@/components/Switch";
import { Segmented } from "@/lib/seg";
import { flowBridge, type FlowPermissionName } from "@/lib/flow/bridge";
import { useFlowConfig, type FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { Section } from "@/components/settings/Section";
import { BrainPicker } from "./BrainPicker";

// The Flow tab of Settings. Every control writes straight through to the store,
// and what comes back from the write is what the screen then shows: the parse is
// the authority, so a clamped value is visible rather than silently different
// from what was clicked.

const IDLE_CHOICES = [
  { ms: 90_000, label: "90 sec" },
  { ms: 300_000, label: "5 min" },
  { ms: 1_800_000, label: "30 min" },
];

/**
 * How long Flow waits before it decides a sentence is finished. Flow's own, not
 * shared with calls: being cut off mid-sentence costs a click in a call and a
 * whole wrong action here, so hands-free starts patient.
 */
const WAIT_PACES = [
  { id: "patient", label: "Patient", values: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 } },
  { id: "even", label: "Even", values: { threshold: 0.5, holdMs: 4000, redemptionMs: 550 } },
  { id: "quick", label: "Quick", values: { threshold: 0.35, holdMs: 2500, redemptionMs: 350 } },
] as const;

const paceOf = (t: { threshold: number; holdMs: number; redemptionMs: number }) =>
  WAIT_PACES.find((p) => p.values.threshold === t.threshold && p.values.holdMs === t.holdMs && p.values.redemptionMs === t.redemptionMs)?.id ?? "";

const card = "flex flex-col divide-y divide-border rounded-lg bg-card px-4 shadow-[var(--shadow-card)]";
const row = "flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 py-2.5";
const pill = "shrink-0 rounded-full bg-surface-raised px-3 py-1.5 text-label font-medium transition hover:bg-foreground/10";

export function FlowSettings() {
  const { config, save, error, saving } = useFlowConfig();

  if (!config) return <p className="text-body text-muted-foreground">{error || "Reading Flow's settings…"}</p>;

  const quiet = config.voice.autoQuiet;

  return (
    <div className="flex flex-col gap-7">
      <p className="flex flex-wrap items-center gap-1.5 text-body text-foreground">
        Tap <Keycap className="text-label">{CONTROL}</Keycap> <Keycap className="text-label">{CONTROL}</Keycap> anywhere to talk. Again to close.
      </p>
      {error && <p className="text-label text-destructive-text">{error}</p>}

      <Section id="set-flow-brain" title="Brain" desc="Who does the thinking. Swapping it keeps every other setting.">
        <BrainPicker config={config} save={save} />
      </Section>

      <Section id="set-flow-voice" title="Voice" desc="How Flow talks back.">
        <div className={card}>
          <Toggle label="Say replies out loud" on={config.voice.speakReplies} onFlip={(speakReplies) => save({ voice: { speakReplies } })} />
          <Row label="Wait before answering">
            <Segmented label="Wait before answering" value={paceOf(config.voice.turn)}
              options={WAIT_PACES.map((p) => ({ id: p.id, label: p.label }))}
              onChange={(id) => save({ voice: { turn: WAIT_PACES.find((p) => p.id === id)!.values } })} />
          </Row>
          <Row label="Stay open after the last reply">
            <select aria-label="Stay open after the last reply"
              className="ol-select h-9 rounded-lg border border-border bg-card px-3 text-label text-foreground outline-none focus:border-border-heavy"
              value={IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) ? String(config.idleWindowMs) : "custom"}
              onChange={(e) => e.target.value !== "custom" && save({ idleWindowMs: Number(e.target.value) })}>
              {!IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) && (
                <option value="custom">{Math.round(config.idleWindowMs / 1000)} sec</option>
              )}
              {IDLE_CHOICES.map((c) => <option key={c.ms} value={c.ms}>{c.label}</option>)}
            </select>
          </Row>
        </div>
      </Section>

      <Section id="set-flow-quiet" title="Go quiet when" desc="Replies switch to text for that turn.">
        <div className={card}>
          <Toggle label="A meeting app is in front" on={quiet.meetingApps}
            onFlip={(meetingApps) => save({ voice: { autoQuiet: { ...quiet, meetingApps } } })} />
          <Toggle label="Another app is using the mic" on={quiet.micContention}
            onFlip={(micContention) => save({ voice: { autoQuiet: { ...quiet, micContention } } })} />
          <Toggle label="Do Not Disturb is on" on={quiet.systemDnd}
            onFlip={(systemDnd) => save({ voice: { autoQuiet: { ...quiet, systemDnd } } })} />
        </div>
      </Section>

      <Section id="set-flow-typing" title="Typing" desc="Paste is instant. Some apps prefer it typed out.">
        <div className={card}>
          <Row label="How text goes in">
            <Segmented label="How text goes in" value={config.insertion.method}
              options={[{ id: "paste" as InsertionMethod, label: "Paste" }, { id: "type" as InsertionMethod, label: "Type it out" }]}
              onChange={(method) => save({ insertion: { method } })} />
          </Row>
          <details className="group py-3">
            <summary className="cursor-pointer list-none text-label text-muted-foreground transition hover:text-foreground [&::-webkit-details-marker]:hidden">
              Advanced timing
            </summary>
            <div className={cn("mt-3 flex flex-col gap-3", config.insertion.method !== "paste" && "opacity-60")}>
              <Range label="Hold the modifier for" min={0} max={300} step={10} value={config.insertion.modifierHoldMs} saving={saving}
                format={(v) => `${v} ms`} onChange={(modifierHoldMs) => save({ insertion: { modifierHoldMs } })} />
              <Range label="Wait before putting the clipboard back" min={0} max={1000} step={25} value={config.insertion.clipboardQuietMs} saving={saving}
                format={(v) => `${v} ms`} onChange={(clipboardQuietMs) => save({ insertion: { clipboardQuietMs } })} />
              <Range label="Give up waiting after" min={1000} max={20_000} step={500} value={config.insertion.clipboardTimeoutMs} saving={saving}
                format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(clipboardTimeoutMs) => save({ insertion: { clipboardTimeoutMs } })} />
            </div>
          </details>
        </div>
      </Section>

      <Section id="set-flow-access" title="Access" desc="What this machine lets Flow do.">
        <AccessRows config={config} save={save} />
      </Section>
    </div>
  );
}

/** The four grants Flow runs on. Shared with the first run so both screens
 *  describe the same switches in the same words. */
export function AccessRows({ config, save }: { config: FlowConfig | null; save: (patch: FlowConfigPatch) => void }) {
  // Polled while shown: macOS never calls back when a grant is given.
  const { caps, error, refresh } = useFlowCapabilities(true);
  if (!isDesktop) return <p className="text-label text-muted-foreground">Available in the desktop app.</p>;

  const perms = caps?.permissions ?? null;
  const ask = (what: FlowPermissionName) => () => void flowBridge()?.request(what).then(refresh);
  const consent = !!config?.consent.granted;

  return (
    <div className={card}>
      {error && (
        <Row label={error}>
          <button type="button" onClick={refresh} className={pill}>Check now</button>
        </Row>
      )}
      <Status label="Microphone" ok={perms?.microphone === "granted"}
        state={perms?.microphone === "granted" ? "Allowed" : perms?.microphone === "denied" ? "Refused" : "Not asked"}
        action={{ label: "Allow", run: ask("microphone") }} />
      <Status label={isMac ? "Accessibility" : "Input access"} ok={!!perms?.accessibility && perms.postEvents !== false}
        state={perms?.accessibility && perms.postEvents !== false ? "Allowed" : "Not allowed"}
        action={{ label: isMac ? "Open System Settings" : "Allow", run: () => void flowBridge()?.init().then(refresh) }} />
      <Status label="Screen" ok={!!perms?.screenRecording && caps?.report?.capture !== false}
        state={!perms?.screenRecording ? "Not allowed" : caps?.report?.capture === false ? "Reopen OpenLive to use it" : "Allowed"}
        action={perms?.screenRecording ? undefined : { label: "Allow", run: ask("screen") }} />
      <Status label="Act on this machine" ok={consent} state={consent ? "Allowed" : "Asks first"}
        action={{
          label: consent ? "Take it back" : "Allow",
          run: () => save({ consent: consent ? { granted: false, at: "" } : { granted: true, at: new Date().toISOString() } }),
        }} keep />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={row}>
      <span className="min-w-[8rem] flex-1 break-words text-label text-foreground">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ label, on, onFlip }: { label: string; on: boolean; onFlip: (v: boolean) => void }) {
  return (
    <label className={cn(row, "cursor-pointer select-none")}>
      <span className="min-w-0 flex-1 break-words text-label text-foreground">{label}</span>
      <Switch on={on} onFlip={() => onFlip(!on)} />
    </label>
  );
}

/** A grant: a dot, a word, and the one thing to do about it. The action hides
 *  once granted, except where granting is also the way back out (`keep`). */
function Status({ label, ok, state, action, keep }: {
  label: string; ok: boolean; state: string; action?: { label: string; run: () => void }; keep?: boolean;
}) {
  return (
    <Row label={label}>
      <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-arc")} />
        {state}
      </span>
      {action && (keep || !ok) && <button type="button" onClick={action.run} className={pill}>{action.label}</button>}
    </Row>
  );
}

/** Moves locally and saves once, when the thumb is let go or a key has moved it.
 *  A write per tick lagged behind the thumb, and each reply snapped it back. */
function Range({ label, min, max, step, value, saving, format, onChange }: {
  label: string; min: number; max: number; step: number; value: number; saving: boolean; format: (v: number) => string; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  // Held until the write settles, so the thumb never jumps back to the old value
  // while the new one is on its way; a refused write lands on what was stored.
  useEffect(() => { if (!saving) setDraft(null); }, [value, saving]);
  // The native `change` is the release (or one key press); React's onChange is every tick.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => {
      const v = Number(el.value);
      if (v === latest.current.value) setDraft(null);
      else latest.current.onChange(v);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  const shown = draft ?? value;
  return (
    <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-[12rem] flex-1 text-label text-muted-foreground">{label}</span>
      <input ref={input} type="range" min={min} max={max} step={step} value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        className="h-1.5 min-w-[8rem] flex-[2] cursor-pointer appearance-none rounded-full bg-border accent-[var(--accent)]" />
      <span className="w-[4.5rem] shrink-0 text-right font-mono text-label tabular-nums">{format(shown)}</span>
    </label>
  );
}
