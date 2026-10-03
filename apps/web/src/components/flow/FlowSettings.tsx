"use client";

import { useEffect, useState } from "react";
import type { FlowConfig } from "@openlive/flow-store";
import { Keyboard, TextCursorInput } from "lucide-react";
import { flowBrain, flowTurn } from "@openlive/flow-store/shared";
import { desktopPlatform, isDesktop, isMac } from "@/lib/platform";
import { Keycaps, Switch, Select, Button, linkClass, ListGroup, ListRow, Segmented, type DotTone } from "@/components/ui";
import { flowBridge, type FlowPermissionName, type PermissionAskedFrom } from "@/lib/flow/bridge";
import { useFlowConfig, type FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useWindowShown } from "@/lib/windowShown";
import { effectiveWait } from "@/lib/flow/wait";
import { dndNote } from "@/lib/flow/quiet";
import { keyListenerNote } from "@/lib/flow/failure";
import { hotkeyKeys, keyName, liveKeys, silenceLabel, type Talk } from "@/lib/dictate/hotkey";
import { familyInfo, loadPipelineConfig, onPipelineConfig, turnPresetOf, TURN_PRESETS, type PipelineConfig } from "@/lib/live/pipelineConfig";
import { api, type ComputerGrant, type ComputerStatus } from "@/lib/api";
import { Section } from "@/components/settings/Section";
import { LinkRow, useSettingsNav } from "@/components/settings/nav";
import { ModeOnLine, MoreMenu, QueryState, StatusDot } from "@/components/settings/common";
import { AnswerSummary, useDefaultBrain, WhoAnswers } from "@/components/settings/WhoAnswers";
import { AddonCard } from "./AddonCard";

// The Flow tab of Settings: only what Flow does that Chat does not, plus rows
// that show the shared settings Flow follows and go to them. Every control
// writes straight through to the store, and what comes back from the write is
// what the screen then shows: the parse is the authority, so a clamped value is
// visible rather than silently different from what was clicked.

const presetName = (v: Parameters<typeof turnPresetOf>[0]) => TURN_PRESETS.find((p) => p.id === turnPresetOf(v))?.name ?? "Custom";

/** The shared voice in words: its name and speed. */
function voiceLine(c: PipelineConfig): string {
  const family = familyInfo("tts", c.tts.family);
  const name = family?.id === "clone" ? "Your voice" : family?.voices?.find((v) => v.id === c.tts.voice)?.name ?? (c.tts.voice || "Default");
  return `${name} · ${c.tts.speed.toFixed(2)}×`;
}

export function FlowSettings() {
  const { config, save, error, loading, refetch } = useFlowConfig();
  const answers = useDefaultBrain();
  const go = useSettingsNav();
  const [pipeline, setPipeline] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setPipeline), []);
  const { caps, refresh } = useFlowCapabilities();
  const keyNote = keyListenerNote(caps);

  if (!config) return <QueryState loading={loading} error={error || null} retrying={false} onRetry={refetch} what="read Flow's settings" />;

  const quiet = config.voice.autoQuiet;
  const ownBrain = config.brain.override;
  const ownWait = flowTurn(config) !== null;
  const shared = effectiveWait("chat", pipeline, null);
  const own = config.voice.turn;
  const ownPace = turnPresetOf(own);
  const keys = liveKeys(config.talk);

  return (
    <div className="flex flex-col gap-7">
      {caps && <ModeOnLine id="set-flow-status" mode="flow" on={caps.armed} />}
      <Section id="set-flow-trigger" title="Trigger" desc="How you open Flow, from any app. Set in General.">
        {caps?.addonError
          ? <AddonCard error={caps.addonError} packaged={caps.packaged} onRetry={refresh} />
          : (
            <ListGroup>
              <LinkRow icon={Keyboard} label="Open and close" detail="Double-tap in any app" shared={false} onGo={() => go("general", "set-general-flow-key")}
                value={<Keycaps keys={hotkeyKeys(keys.flow, desktopPlatform)} label={`Double-tap ${keyName(keys.flow, desktopPlatform)}`} />} />
              <TalkLinks talk={config.talk} />
              {keyNote && <div className="py-2"><StatusDot tone={caps?.hookError ? "danger" : "arc"}>{keyNote}</StatusDot></div>}
            </ListGroup>
          )}
      </Section>
      {error && <p className="text-label text-destructive-text">{error}</p>}

      <Section id="set-flow-brain" title="Who answers" desc="Flow follows the default, or has its own.">
        <div className="flex flex-col gap-3">
          <ListGroup>
            <ListRow label="Who answers in Flow" detail={ownBrain ? "Only in Flow. The default is unchanged." : undefined}>
              <Select aria-label="Who answers in Flow" value={ownBrain ? "own" : "default"}
                onChange={(e) => save({ brain: e.target.value === "own" ? { ...answers.brain, override: true } : { override: false } })}>
                <option value="default">Same as default</option>
                <option value="own">Its own</option>
              </Select>
            </ListRow>
            {!ownBrain && <LinkRow label="The default" value={<AnswerSummary brain={answers.brain} />} onGo={() => go("models", "set-models-default")} />}
          </ListGroup>
          {ownBrain && <WhoAnswers id="flow" label="Who answers in Flow" value={flowBrain(config, {})} onPick={(brain) => save({ brain })} />}
        </div>
      </Section>

      <Section id="set-flow-voice" title="Voice" desc="How Flow talks back.">
        <ListGroup>
          <Toggle label="Say replies out loud" on={config.voice.speakReplies} onFlip={(speakReplies) => save({ voice: { speakReplies } })} />
          <LinkRow label="Voice" detail="Set once for every mode" value={voiceLine(pipeline)} onGo={() => go("voice", "set-voice-voice")} />
          {!ownWait && (
            <LinkRow label="Wait before answering" value={presetName(shared)} onGo={() => go("voice", "set-voice-wait")} />
          )}
          <div id="set-flow-wait">
            <Toggle label="Use a different pace for Flow" on={ownWait} onFlip={(turnOverride) => save({ voice: { turnOverride } })}
              detail="Flow can wait longer" info="Dictating is slower than chatting, so Flow can wait longer before it answers." />
          </div>
          {ownWait && (
            <div className="flex flex-col gap-2 py-3">
              <Segmented label="Flow's wait before answering" className="grid w-full" value={ownPace === "custom" ? null : ownPace}
                options={TURN_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: `Up to ${p.values.holdMs / 1000} s`, title: p.desc }))}
                onChange={(id) => save({ voice: { turn: TURN_PRESETS.find((p) => p.id === id)!.values } })} />
              {ownPace === "custom" && <p className="text-caption text-faint">Custom: Flow keeps timings from an earlier version. Pick one to replace them.</p>}
            </div>
          )}
        </ListGroup>
      </Section>

      <Section id="set-flow-quiet" title="Go quiet when" desc="Replies switch to text for that turn.">
        <ListGroup>
          <Toggle label="A meeting app is in front" on={quiet.meetingApps}
            onFlip={(meetingApps) => save({ voice: { autoQuiet: { ...quiet, meetingApps } } })} />
          <Toggle label="Another app is using the mic" on={quiet.micContention}
            onFlip={(micContention) => save({ voice: { autoQuiet: { ...quiet, micContention } } })} />
          <Toggle label="Do Not Disturb is on" on={quiet.systemDnd} info={dndNote(desktopPlatform) || undefined}
            onFlip={(systemDnd) => save({ voice: { autoQuiet: { ...quiet, systemDnd } } })} />
        </ListGroup>
      </Section>

      <Section id="set-flow-access" title="Access" desc="What this machine lets Flow do.">
        <AccessRows config={config} save={save} />
      </Section>

      <Section id="set-flow-typing" title="Typing at cursor" desc="Shared with Dictate, set in General.">
        <ListGroup>
          <LinkRow icon={TextCursorInput} label="Paste or type, clipboard" value="General" shared={false} onGo={() => go("general", "set-general-typing")} />
        </ListGroup>
      </Section>

      <p className="text-label leading-relaxed text-muted-foreground">
        Flow also uses the shared <SharedLink onGo={() => go("voice", "set-voice-language")}>Language</SharedLink>,{" "}
        <SharedLink onGo={() => go("voice", "set-voice-pronunciation")}>Pronunciation</SharedLink> and{" "}
        <SharedLink onGo={() => go("engine")}>Speech engine</SharedLink>. Change them once, every mode follows.
      </p>
    </div>
  );
}

/** How you talk and Close after silence, set in General for Flow and Dictate alike. Shared with Dictate's settings. */
export function TalkLinks({ talk }: { talk: Talk }) {
  const go = useSettingsNav();
  const silence = talk.closeAfterSilenceMs;
  return (
    <>
      <LinkRow label="How you talk" onGo={() => go("general", "set-general-talk")}
        value={talk.mode === "ptt" ? `Push to talk, hold ${keyName(talk.pttKey, desktopPlatform)}` : "Hands-free"} />
      <LinkRow label="Close after silence" onGo={() => go("general", "set-general-silence")}
        value={silence === null ? "Never" : silenceLabel(silence)} />
    </>
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
  const micOk = perms?.microphone === "granted";
  const inputOk = !!perms?.accessibility && perms.postEvents !== false;
  const screenOk = !!perms?.screenRecording && caps?.report?.capture !== false;
  // A row with no ⋯ keeps its place while another row shows one, so every Allow lines up.
  const menuSlot = (!micOk && !!settings("microphone")) || (!inputOk && !!settings("accessibility")) || (!screenOk && !!settings("screen"));

  return (
    <ListGroup>
      {error && (
        <ListRow label={<StatusDot tone="danger">{error}</StatusDot>}>
          <Button size="sm" onClick={refresh}>Check now</Button>
        </ListRow>
      )}
      <Status label="Microphone" ok={micOk}
        state={micOk ? "Allowed" : perms?.microphone === "denied" ? "Refused" : "Not asked"}
        tone={perms?.microphone === "denied" ? "danger" : undefined}
        action={{ label: "Allow", run: ask("microphone") }} settings={settings("microphone")} />
      <Status label={isMac ? "Accessibility" : "Input access"} ok={inputOk}
        state={inputOk ? "Allowed" : "Not allowed"}
        action={{ label: "Allow", run: ask("accessibility") }} settings={settings("accessibility")} />
      <Status label="Screen" ok={screenOk}
        state={!perms?.screenRecording ? "Not allowed" : caps?.report?.capture === false ? "Reopen OpenLive to use it" : "Allowed"}
        action={perms?.screenRecording ? undefined : { label: "Allow", run: ask("screen") }} settings={settings("screen")} />
      {computer.status?.available && computer.status.grants.map((g) => (
        <Status key={g.id} label={`Computer use: ${g.id === "accessibility" ? "Accessibility" : "Screen"}`} ok={g.granted}
          state={g.granted ? "Allowed" : "Not allowed"} action={{ label: "Allow", run: () => computer.request(g.id) }}
          detail={g.granted ? undefined : g.detail} menuSlot={menuSlot} />
      ))}
      <Status label="Act on this machine" ok={consent} state={consent ? "Allowed" : "Asks first"}
        action={{
          label: consent ? "Take it back" : "Allow",
          run: () => save({ consent: consent ? { granted: false, at: "" } : { granted: true, at: new Date().toISOString() } }),
        }} keep menuSlot={menuSlot} />
    </ListGroup>
  );
}

/** The computer-use helper's grants, polled while shown for the same reason as Flow's. */
function useComputerGrants(enabled: boolean) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const shown = useWindowShown();
  useEffect(() => {
    if (!enabled || !shown) return;
    let live = true;
    const read = () => api.computerPermissions().then((s) => { if (live) setStatus(s); }).catch(() => {});
    void read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [enabled, shown]);
  const request = (id: ComputerGrant["id"]) => void api.requestComputerPermission(id).then(setStatus).catch(() => {});
  return { status, request };
}

function Toggle({ label, detail, info, on, onFlip }: { label: string; detail?: string; info?: string; on: boolean; onFlip: (v: boolean) => void }) {
  return (
    <ListRow label={label} detail={detail} info={info} asLabel>
      <Switch on={on} onFlip={() => onFlip(!on)} />
    </ListRow>
  );
}

/** A grant: a dot, a word, and the one thing to do about it. The action hides
 *  once granted, except where granting is also the way back out (`keep`).
 *  `settings` is the way in by hand, for when the prompt is not wanted, under ⋯;
 *  `menuSlot` holds that ⋯'s room on a row without one. */
function Status({ label, ok, state, tone, action, keep, settings, detail, menuSlot }: {
  label: string; ok: boolean; state: string; tone?: DotTone; action?: { label: string; run: () => void }; keep?: boolean; settings?: () => void; detail?: string; menuSlot?: boolean;
}) {
  const acting = !!action && (keep || !ok);
  const menu = !!settings && !ok;
  return (
    <ListRow label={label} detail={detail}>
      <span className="shrink-0"><StatusDot tone={tone ?? (ok ? "success" : "arc")}>{state}</StatusDot></span>
      {acting && <Button size="sm" onClick={action.run}>{action.label}</Button>}
      {menu ? <MoreMenu label={`More for ${label}`} actions={[{ label: "Open system settings", run: settings }]} />
        : acting && menuSlot && <span aria-hidden className="size-control-sm shrink-0" />}
    </ListRow>
  );
}
