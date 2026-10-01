import { telemetrySchema, type TelemetryEventProps } from "@openlive/shared";
import { isLoopbackUrl } from "@openlive/harness/registry";
import type { FlowConfig } from "@openlive/flow-store";
import { flowBrain } from "@openlive/flow-store/shared";
import { activeTurnPreset, loadPipelineConfig, onPipelineConfig, turnPresetOf, type PipelineConfig } from "./live/pipelineConfig";
import { telemetry } from "./telemetry";
import { sttFamilyOf, ttsFamilyOf } from "./telemetryIds";
import { useUi } from "./uiStore";

// What a person changed in Settings, as the closed values setting_changed takes.
// Each writer hands over the state before and after, so only a real change is
// reported. Values that are free text, ids or paths (custom instructions, model
// ids, an Ollama address, a project folder) are reduced to what happened to
// them: set or cleared, changed or cleared, default, local or remote.

type Props = TelemetryEventProps<"setting_changed">;
type Change = Omit<Props, "from">;
type From = NonNullable<Props["from"]>;
type Rec = Readonly<Record<string, string | undefined>>;

const { provider: PROVIDERS, agent: AGENTS } = telemetrySchema.subjects;
const providerOf = (v?: string) => PROVIDERS.find((p) => p === v);
const agentOf = (v?: string) => AGENTS.find((a) => a === v);
const onOff = (v: boolean): "on" | "off" => (v ? "on" : "off");
const filled = (v?: string) => !!v?.trim();

// ── the debounced reporter ────────────────────────────────────────────────
// A slider, or a text field written per keystroke, changes the same setting
// many times a second. One event per setting once it has been still this long.
export const SETTING_DEBOUNCE_MS = 1500;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

const ambient = { onboarding: false };
/** Flow's first run is on screen: a setting changed there is part of onboarding. */
export const flowOnboardingOpen = (on: boolean): void => { ambient.onboarding = on; };

/** Which screen the person is changing a setting from, read when they change it. */
export function settingSurface(): From {
  const ui = useUi.getState();
  if (ui.settingsOpen) return "settings";
  if (ambient.onboarding) return "onboarding";
  if (ui.liveOpen) return "call_setup";
  return ui.mode === "flow" ? "flow_home" : "other";
}

export function reportSetting(change: Change): void {
  const key = `${change.setting}:${change.subject ?? ""}`;
  clearTimeout(pending.get(key));
  const from = settingSurface();
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    telemetry.track("setting_changed", { ...change, from });
  }, SETTING_DEBOUNCE_MS));
}

// ── server settings (/api/settings) ───────────────────────────────────────
const EFFORTS = telemetrySchema.settings.api_effort.values;
const HIDDEN = "agentHidden:";

/** Pure. O(keys). */
export function serverChanges(before: Rec, after: Rec): Change[] {
  const out: Change[] = [];
  const changed = (k: string) => (before[k] ?? "") !== (after[k] ?? "");
  if (changed("customInstructions") && filled(before.customInstructions) !== filled(after.customInstructions)) {
    out.push({ setting: "custom_instructions", value: filled(after.customInstructions) ? "set" : "cleared" });
  }
  if (changed("narrateProgress")) out.push({ setting: "narrate_progress", value: onOff(after.narrateProgress !== "0") });
  const provider = providerOf(after.liveProviderId);
  if (changed("liveProviderId") && provider) out.push({ setting: "api_provider", value: "none", subject: provider });
  // A model emptied because its provider just changed is a reset, not a choice.
  if (changed("liveModel") && !(changed("liveProviderId") && !after.liveModel)) {
    out.push({ setting: "api_model", value: after.liveModel ? "changed" : "cleared", subject: provider ?? "none" });
  }
  if (changed("visionModel") && !(changed("visionProviderId") && !after.visionModel)) {
    out.push({ setting: "vision_model", value: after.visionModel ? "changed" : "cleared", subject: providerOf(after.visionProviderId) ?? "none" });
  }
  if (changed("liveEffort")) out.push({ setting: "api_effort", value: EFFORTS.find((e) => e === after.liveEffort) ?? "auto" });
  if (changed("ollamaBaseUrl")) {
    out.push({ setting: "ollama_address", value: !after.ollamaBaseUrl ? "default" : isLoopbackUrl(after.ollamaBaseUrl) ? "local" : "remote" });
  }
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const agent = k.startsWith(HIDDEN) ? agentOf(k.slice(HIDDEN.length)) : undefined;
    if (agent && changed(k)) out.push({ setting: "agent_hidden", value: onOff(!!after[k]), subject: agent });
  }
  return out;
}

let known: Rec | undefined;
/** The settings as the server last said them: what the next write is compared with. */
export function seedServerSettings<T extends Rec>(s: T): T {
  known = { ...s };
  return s;
}
/** The settings after a write. Anything that differs from the last known state is reported. */
export function serverSettingsChanged<T extends Rec>(s: T): T {
  if (known) serverChanges(known, s).forEach(reportSetting);
  return seedServerSettings(s);
}

/** A provider key was saved or removed. Only which provider, never the key. */
export function providerKeyChanged(kind: string, value: "added" | "removed"): void {
  const subject = providerOf(kind);
  if (!subject) return;
  reportSetting({ setting: "provider_key", value, subject });
  if (value === "added") telemetry.track("onboarding_step", { step: "first_provider_key_saved" });
}

// ── Flow config ───────────────────────────────────────────────────────────
const IDLE_WINDOWS = new Map<number, "90s" | "5m" | "30m">([[90_000, "90s"], [300_000, "5m"], [1_800_000, "30m"]]);

/** Pure. */
export function flowChanges(a: FlowConfig, b: FlowConfig): Change[] {
  const out: Change[] = [];
  const flip = (setting: Change["setting"], x: boolean, y: boolean) => { if (x !== y) out.push({ setting, value: onOff(y) }); };
  flip("flow_own_brain", a.brain.override, b.brain.override);
  const from = flowBrain(a);
  const to = flowBrain(b);
  if (from.kind !== to.kind || from.agentId !== to.agentId) {
    out.push({ setting: "flow_brain", value: to.kind, subject: (to.kind === "acp" && agentOf(to.agentId)) || "none" });
  }
  flip("flow_speak_replies", a.voice.speakReplies, b.voice.speakReplies);
  flip("flow_own_wait", a.voice.turnOverride === true, b.voice.turnOverride === true);
  const t0 = a.voice.turn;
  const t1 = b.voice.turn;
  if (t0.threshold !== t1.threshold || t0.holdMs !== t1.holdMs || t0.redemptionMs !== t1.redemptionMs) {
    out.push({ setting: "wait_preset", value: turnPresetOf(t1) });
  }
  flip("flow_quiet_meeting", a.voice.autoQuiet.meetingApps, b.voice.autoQuiet.meetingApps);
  flip("flow_quiet_mic", a.voice.autoQuiet.micContention, b.voice.autoQuiet.micContention);
  flip("flow_quiet_dnd", a.voice.autoQuiet.systemDnd, b.voice.autoQuiet.systemDnd);
  flip("flow_consent", a.consent.granted, b.consent.granted);
  if (a.insertion.method !== b.insertion.method) out.push({ setting: "flow_insertion", value: b.insertion.method });
  if (a.idleWindowMs !== b.idleWindowMs) out.push({ setting: "flow_idle_window", value: IDLE_WINDOWS.get(b.idleWindowMs) ?? "custom" });
  return out;
}

/** Flow's config was written. A `settle` write is a migration the person never made. */
export function flowConfigChanged(before: FlowConfig | undefined, after: FlowConfig, settle?: boolean): void {
  if (!before || settle) return;
  flowChanges(before, after).forEach(reportSetting);
  if (!before.consent.granted && after.consent.granted) telemetry.track("onboarding_step", { step: "flow_consent_granted" });
}

// ── voice pipeline (localStorage) ─────────────────────────────────────────
/** Pure. A language change swaps the engines with it, and that counts as the one change. */
export function pipelineChanges(a: PipelineConfig, b: PipelineConfig): Change[] {
  const out: Change[] = [];
  if (a.language !== b.language) out.push({ setting: "language", value: b.language });
  else {
    const stt = sttFamilyOf(b.stt.family);
    const tts = ttsFamilyOf(b.tts.family);
    if (a.stt.family !== b.stt.family && stt) out.push({ setting: "stt_family", value: stt });
    if (a.tts.family !== b.tts.family && tts) out.push({ setting: "tts_family", value: tts });
  }
  const wait = activeTurnPreset(b);
  if (activeTurnPreset(a) !== wait) out.push({ setting: "wait_preset", value: wait });
  if (a.voiceprint !== b.voiceprint) out.push({ setting: "voiceprint", value: b.voiceprint });
  if (a.sideTalk !== b.sideTalk) out.push({ setting: "side_talk", value: b.sideTalk });
  if (a.allowRestricted !== b.allowRestricted) out.push({ setting: "allow_restricted", value: onOff(b.allowRestricted) });
  return out;
}

/** Reports each change to the saved voice pipeline, whichever screen saved it. Returns the unsubscribe. */
export function watchPipelineConfig(): () => void {
  let before = loadPipelineConfig();
  return onPipelineConfig((after) => {
    pipelineChanges(before, after).forEach(reportSetting);
    before = after;
  });
}
