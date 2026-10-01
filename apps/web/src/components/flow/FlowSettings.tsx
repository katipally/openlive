"use client";

import { useEffect, useState } from "react";
import type { FlowConfig, InsertionMethod } from "@openlive/flow-store";
import { flowTurn } from "@openlive/flow-store/shared";
import { CONTROL, desktopPlatform, isDesktop, isMac } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { Keycap, Switch, Select, Slider, Button, linkClass, ListGroup, ListRow, Segmented, Advanced } from "@/components/ui";
import { flowBridge, type FlowPermissionName, type PermissionAskedFrom } from "@/lib/flow/bridge";
import { useFlowConfig, type FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { effectiveWait } from "@/lib/flow/wait";
import { dndNote } from "@/lib/flow/quiet";
import { keyListenerNote } from "@/lib/flow/failure";
import { familyInfo, loadPipelineConfig, onPipelineConfig, turnPresetOf, TURN_PRESETS, type PipelineConfig } from "@/lib/live/pipelineConfig";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { api, type ComputerGrant, type ComputerStatus } from "@/lib/api";
import { Section } from "@/components/settings/Section";
import { LinkRow, useSettingsNav } from "@/components/settings/nav";
import { BrainPicker } from "./BrainPicker";
import { AddonCard } from "./AddonCard";

// The Flow tab of Settings: only what Flow does that Chat does not, plus rows
// that show the shared settings Flow follows and go to them. Every control
// writes straight through to the store, and what comes back from the write is
// what the screen then shows: the parse is the authority, so a clamped value is
// visible rather than silently different from what was clicked.

const IDLE_CHOICES = [
  { ms: 90_000, label: "90 sec" },
  { ms: 300_000, label: "5 min" },
  { ms: 1_800_000, label: "30 min" },
];

const presetName = (v: Parameters<typeof turnPresetOf>[0]) => TURN_PRESETS.find((p) => p.id === turnPresetOf(v))?.name ?? "Custom";

/** The shared voice in words: its name and speed. */
function voiceLine(c: PipelineConfig): string {
  const family = familyInfo("tts", c.tts.family);
  const name = family?.id === "clone" ? "Your voice" : family?.voices?.find((v) => v.id === c.tts.voice)?.name ?? (c.tts.voice || "Default");
  return `${name} · ${c.tts.speed.toFixed(2)}×`;
}

export function FlowSettings() {
  const { config, save, error, saving } = useFlowConfig();
  const choice = useApiModeChoice();
  const go = useSettingsNav();
  const [pipeline, setPipeline] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setPipeline), []);
  const { caps, refresh } = useFlowCapabilities();
  const keyNote = keyListenerNote(caps);

  if (!config) return <p className="text-body text-muted-foreground">{error || "Reading Flow's settings…"}</p>;

  const quiet = config.voice.autoQuiet;
  const ownBrain = config.brain.override;
  const ownWait = flowTurn(config) !== null;
  const shared = effectiveWait("chat", pipeline, null);
  const own = config.voice.turn;
  const ownPace = turnPresetOf(own);

  return (
    <div className="flex flex-col gap-7">
      <p className="flex flex-wrap items-center gap-1.5 text-body text-foreground">
        Tap <Keycap className="text-label">{CONTROL}</Keycap> <Keycap className="text-label">{CONTROL}</Keycap> anywhere to talk. Again to close.
      </p>
      {caps?.addonError
        ? <AddonCard error={caps.addonError} packaged={caps.packaged} onRetry={refresh} />
        : keyNote && <p className="text-label text-muted-foreground">{keyNote}</p>}
      {error && <p className="text-label text-destructive-text">{error}</p>}

      <Section id="set-flow-brain" title="Brain" desc="Who does the thinking. Swapping it keeps every other setting.">
        <div className="flex flex-col gap-3">
          <ListGroup>
            {!ownBrain && (
              <LinkRow label="Who does the thinking" onGo={() => go("models")}
                value={choice.loading ? "\u2026" : !choice.usable ? `${choice.providerName} has no key yet` : `API mode · ${choice.model}`} />
            )}
            <Toggle label="Use a different one for Flow" on={ownBrain} onFlip={(override) => save({ brain: { override } })}
              detail={ownBrain ? "Flow thinks with the one picked below. Chat is unchanged." : "Off: Flow thinks as a new chat does, with API mode from Models."} />
          </ListGroup>
          {ownBrain && <BrainPicker config={config} save={save} />}
        </div>
      </Section>

      <Section id="set-flow-voice" title="Voice" desc="How Flow talks back.">
        <ListGroup>
          <Toggle label="Say replies out loud" on={config.voice.speakReplies} onFlip={(speakReplies) => save({ voice: { speakReplies } })} />
          <LinkRow label="Voice" detail="Language, voice, speed and pronunciation are shared." value={voiceLine(pipeline)} onGo={() => go("voice", "set-voice-voice")} />
          {!ownWait && (
            <LinkRow label="Wait before answering" value={presetName(shared)} onGo={() => go("voice", "set-voice-wait")} />
          )}
          <div id="set-flow-wait">
            <Toggle label="Use a different pace for Flow" on={ownWait} onFlip={(turnOverride) => save({ voice: { turnOverride } })}
              detail="Dictating is slower than chatting. Flow can wait longer." />
          </div>
          {ownWait && (
            <div className="flex flex-col gap-2 py-3">
              <Segmented label="Flow's wait before answering" className="grid w-full" value={ownPace === "custom" ? null : ownPace}
                options={TURN_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: `Up to ${p.values.holdMs / 1000} s`, title: p.desc }))}
                onChange={(id) => save({ voice: { turn: TURN_PRESETS.find((p) => p.id === id)!.values } })} />
              {ownPace === "custom" && <p className="text-caption text-faint">Custom: Flow keeps timings from an earlier version. Pick one to replace them.</p>}
            </div>
          )}
          <ListRow label="Stay open after the last reply">
            <Select aria-label="Stay open after the last reply"
              value={IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) ? String(config.idleWindowMs) : "custom"}
              onChange={(e) => e.target.value !== "custom" && save({ idleWindowMs: Number(e.target.value) })}>
              {!IDLE_CHOICES.some((c) => c.ms === config.idleWindowMs) && (
                <option value="custom">{Math.round(config.idleWindowMs / 1000)} sec</option>
              )}
              {IDLE_CHOICES.map((c) => <option key={c.ms} value={c.ms}>{c.label}</option>)}
            </Select>
          </ListRow>
        </ListGroup>
      </Section>

      <Section id="set-flow-quiet" title="Go quiet when" desc="Replies switch to text for that turn.">
        <ListGroup>
          <Toggle label="A meeting app is in front" on={quiet.meetingApps}
            onFlip={(meetingApps) => save({ voice: { autoQuiet: { ...quiet, meetingApps } } })} />
          <Toggle label="Another app is using the mic" on={quiet.micContention}
            onFlip={(micContention) => save({ voice: { autoQuiet: { ...quiet, micContention } } })} />
          <Toggle label="Do Not Disturb is on" on={quiet.systemDnd} detail={dndNote(desktopPlatform) || undefined}
            onFlip={(systemDnd) => save({ voice: { autoQuiet: { ...quiet, systemDnd } } })} />
        </ListGroup>
      </Section>

      <Section id="set-flow-typing" title="Typing" desc="Paste is instant. Some apps prefer it typed out.">
        <ListGroup>
          <ListRow label="How text goes in">
            <Segmented label="How text goes in" value={config.insertion.method}
              options={[{ id: "paste" as InsertionMethod, label: "Paste" }, { id: "type" as InsertionMethod, label: "Type it out" }]}
              onChange={(method) => save({ insertion: { method } })} />
          </ListRow>
          <Advanced id="flow:typing" label="Advanced timing" className="py-1">
            <div className={cn("flex flex-col gap-3", config.insertion.method !== "paste" && "opacity-60")}>
              <Slider label="Hold the modifier for" min={0} max={300} step={10} value={config.insertion.modifierHoldMs} commitOnRelease saving={saving}
                format={(v) => `${v} ms`} onChange={(modifierHoldMs) => save({ insertion: { modifierHoldMs } })} />
              <Slider label="Wait before putting the clipboard back" min={0} max={1000} step={25} value={config.insertion.clipboardQuietMs} commitOnRelease saving={saving}
                format={(v) => `${v} ms`} onChange={(clipboardQuietMs) => save({ insertion: { clipboardQuietMs } })} />
              <Slider label="Give up waiting after" min={1000} max={20_000} step={500} value={config.insertion.clipboardTimeoutMs} commitOnRelease saving={saving}
                format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(clipboardTimeoutMs) => save({ insertion: { clipboardTimeoutMs } })} />
            </div>
          </Advanced>
        </ListGroup>
      </Section>

      <Section id="set-flow-access" title="Access" desc="What this machine lets Flow do.">
        <AccessRows config={config} save={save} />
      </Section>

      <p className="text-label leading-relaxed text-muted-foreground">
        Flow also uses the shared <SharedLink onGo={() => go("voice", "set-voice-language")}>Language</SharedLink>,{" "}
        <SharedLink onGo={() => go("voice", "set-voice-pronunciation")}>Pronunciation</SharedLink> and{" "}
        <SharedLink onGo={() => go("engine")}>Speech engine</SharedLink>. Change them once, both modes follow.
      </p>
    </div>
  );
}

function SharedLink({ onGo, children }: { onGo: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onGo} className={linkClass}>{children}</button>;
}

/** The four grants Flow runs on. Shared with the first run so both screens
 *  describe the same switches in the same words. */
export function AccessRows({ config, save, askedFrom = "flow_settings" }: { config: FlowConfig | null; save: (patch: FlowConfigPatch) => void; askedFrom?: PermissionAskedFrom }) {
  // Polled while shown: macOS never calls back when a grant is given.
  const { caps, error, refresh } = useFlowCapabilities(true);
  // Windows has no grant to give the helper; macOS and Linux do.
  const computer = useComputerGrants(isDesktop && (isMac || desktopPlatform === "linux"));
  if (!isDesktop) return <p className="text-label text-muted-foreground">Available in the desktop app.</p>;

  const perms = caps?.permissions ?? null;
  const ask = (what: FlowPermissionName) => () => void flowBridge()?.request(what, askedFrom).then(refresh);
  // Where the platform has a settings page for the grant: all three on macOS, the microphone on Windows.
  const settings = (what: FlowPermissionName) =>
    isMac || (desktopPlatform === "win32" && what === "microphone") ? () => void flowBridge()?.openSettings(what) : undefined;
  const consent = !!config?.consent.granted;

  return (
    <ListGroup>
      {error && (
        <ListRow label={error}>
          <Button size="sm" onClick={refresh}>Check now</Button>
        </ListRow>
      )}
      <Status label="Microphone" ok={perms?.microphone === "granted"}
        state={perms?.microphone === "granted" ? "Allowed" : perms?.microphone === "denied" ? "Refused" : "Not asked"}
        action={{ label: "Allow", run: ask("microphone") }} settings={settings("microphone")} />
      <Status label={isMac ? "Accessibility" : "Input access"} ok={!!perms?.accessibility && perms.postEvents !== false}
        state={perms?.accessibility && perms.postEvents !== false ? "Allowed" : "Not allowed"}
        action={{ label: "Allow", run: ask("accessibility") }} settings={settings("accessibility")} />
      <Status label="Screen" ok={!!perms?.screenRecording && caps?.report?.capture !== false}
        state={!perms?.screenRecording ? "Not allowed" : caps?.report?.capture === false ? "Reopen OpenLive to use it" : "Allowed"}
        action={perms?.screenRecording ? undefined : { label: "Allow", run: ask("screen") }} settings={settings("screen")} />
      {computer.status?.available && computer.status.grants.map((g) => (
        <Status key={g.id} label={`Computer use: ${g.id === "accessibility" ? "Accessibility" : "Screen"}`} ok={g.granted}
          state={g.granted ? "Allowed" : "Not allowed"} action={{ label: "Allow", run: () => computer.request(g.id) }}
          detail={g.granted ? undefined : g.detail} />
      ))}
      <Status label="Act on this machine" ok={consent} state={consent ? "Allowed" : "Asks first"}
        action={{
          label: consent ? "Take it back" : "Allow",
          run: () => save({ consent: consent ? { granted: false, at: "" } : { granted: true, at: new Date().toISOString() } }),
        }} keep />
    </ListGroup>
  );
}

/** The computer-use helper's grants, polled while shown for the same reason as Flow's. */
function useComputerGrants(enabled: boolean) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => api.computerPermissions().then((s) => { if (live) setStatus(s); }).catch(() => {});
    void read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [enabled]);
  const request = (id: ComputerGrant["id"]) => void api.requestComputerPermission(id).then(setStatus).catch(() => {});
  return { status, request };
}

function Toggle({ label, detail, on, onFlip }: { label: string; detail?: string; on: boolean; onFlip: (v: boolean) => void }) {
  return (
    <ListRow label={label} detail={detail} asLabel>
      <Switch on={on} onFlip={() => onFlip(!on)} />
    </ListRow>
  );
}

/** A grant: a dot, a word, and the one thing to do about it. The action hides
 *  once granted, except where granting is also the way back out (`keep`).
 *  `settings` is the way in by hand, for when the prompt is not wanted. */
function Status({ label, ok, state, action, keep, settings, detail }: {
  label: string; ok: boolean; state: string; action?: { label: string; run: () => void }; keep?: boolean; settings?: () => void; detail?: string;
}) {
  return (
    <ListRow label={label} detail={detail}>
      <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-arc")} />
        {state}
      </span>
      {settings && !ok && (
        <button type="button" onClick={settings} className={cn("shrink-0 text-caption", linkClass)}>Settings</button>
      )}
      {action && (keep || !ok) && <Button size="sm" onClick={action.run}>{action.label}</Button>}
    </ListRow>
  );
}
