// Settings search, the pure half: every searchable row, where it lives, and how a
// query narrows them. No React, no DOM, so it tests on its own.

import { CURATED_LANGUAGES, STT_FAMILIES, TTS_FAMILIES, type EngineFamilyInfo } from "./live/pipelineConfig";

export type SettingsTabId = "general" | "models" | "flow" | "voice" | "agents" | "about";

// Tabs that were merged away. A deep link or anything persisted with an old id
// still lands on the tab that holds its content now.
const LEGACY_TABS: Record<string, SettingsTabId> = { pipeline: "voice", voices: "voice" };
const TABS: readonly string[] = ["general", "models", "flow", "voice", "agents", "about"] satisfies SettingsTabId[];

export function resolveSettingsTab(id: string | null | undefined): SettingsTabId | null {
  if (!id) return null;
  if (TABS.includes(id)) return id as SettingsTabId;
  return LEGACY_TABS[id] ?? null;
}

export interface SettingsEntry {
  label: string;
  /** Other words a person might type for this row. */
  keywords?: string;
  tab: SettingsTabId;
  /** DOM id of the row (or its section) to scroll to. */
  anchor: string;
  /** Only rendered in the desktop app. */
  desktop?: boolean;
}

/** Each family's name and the parts of its variant ids ("80ms", "fp16",
 *  "thorsten"), so every engine and preset is found by the name it shows. */
const engineWords = (families: EngineFamilyInfo[]) =>
  [...new Set(families.flatMap((f) => [f.name, ...f.variants.map((v) => v.id)]).flatMap((s) => s.toLowerCase().split(/[\s()_-]+/)))].join(" ");
/** Each language in English, in its own name, and in its own name without accents ("espanol"). */
const LANGUAGE_WORDS = CURATED_LANGUAGES.flatMap((l) => [l.name, l.native, l.native.normalize("NFD").replace(/[\u0300-\u036f]/g, "")]).join(" ");

export const SETTINGS_INDEX: SettingsEntry[] = [
  { label: "Appearance", keywords: "theme dark light system mode", tab: "general", anchor: "set-general-appearance" },
  { label: "Your assistant's style", keywords: "custom instructions prompt tone behave", tab: "general", anchor: "set-general-style" },
  { label: "Push-to-talk", keywords: "hold to talk tap to toggle space walkie voice input", tab: "general", anchor: "set-general-speech" },
  { label: "Narrate agent progress", keywords: "spoken steps plan voice", tab: "general", anchor: "set-general-speech" },
  { label: "Keyboard shortcuts", keywords: "keys hotkeys", tab: "general", anchor: "set-general-shortcuts" },
  { label: "Open at login", keywords: "startup launch boot background", tab: "general", anchor: "set-general-startup", desktop: true },

  { label: "Provider & API key", keywords: "byok key openai anthropic paste remove", tab: "models", anchor: "set-models-provider" },
  { label: "Model", keywords: "llm live model vision reasoning", tab: "models", anchor: "set-models-model" },
  { label: "Vision model", keywords: "camera screen images see", tab: "models", anchor: "set-models-vision" },
  { label: "Reasoning effort", keywords: "thinking speed latency", tab: "models", anchor: "set-models-effort" },

  { label: "Flow brain", keywords: "agent model who thinks", tab: "flow", anchor: "set-flow-brain" },
  { label: "Say replies out loud", keywords: "speak voice", tab: "flow", anchor: "set-flow-voice" },
  { label: "Wait before answering", keywords: "pace turn", tab: "flow", anchor: "set-flow-voice" },
  { label: "Stay open after the last reply", keywords: "idle timeout close", tab: "flow", anchor: "set-flow-voice" },
  { label: "Go quiet when", keywords: "meeting mic do not disturb dnd silent text", tab: "flow", anchor: "set-flow-quiet" },
  { label: "How text goes in", keywords: "typing paste type insertion clipboard timing", tab: "flow", anchor: "set-flow-typing" },
  { label: "Access", keywords: "permissions microphone accessibility screen recording consent", tab: "flow", anchor: "set-flow-access" },

  { label: "Language", keywords: `${LANGUAGE_WORDS} speak reply multilingual translate`, tab: "voice", anchor: "set-voice-language" },
  { label: "Speaking speed", keywords: "rate tts fast slow", tab: "voice", anchor: "set-voice-speaking" },
  { label: "Pronunciation", keywords: "dictionary lexicon respell pronounce say read aloud name brand word mispronounced numbers", tab: "voice", anchor: "set-voice-pronunciation" },
  { label: "Voice activity detection", keywords: "vad silero v6 v5 model sensitivity trailing silence", tab: "voice", anchor: "set-voice-stage-mic" },
  { label: "Speech-to-text", keywords: `stt whisper model size transcription speech recognition engine streaming native download variant latency runs on cpu coreml cuda directml accelerator threads benchmark ${engineWords(STT_FAMILIES)}`, tab: "voice", anchor: "set-voice-stage-stt" },
  { label: "Turn-taking", keywords: "smart-turn end of turn detector mid-thought hold preset", tab: "voice", anchor: "set-voice-stage-turn" },
  { label: "Text-to-speech", keywords: `tts kokoro supertonic pocket kitten voice preview engine native download variant runs on cpu coreml cuda directml accelerator threads benchmark license restricted non-commercial allow locked ${engineWords(TTS_FAMILIES)}`, tab: "voice", anchor: "set-voice-stage-tts" },
  { label: "This device", keywords: "hardware cpu gpu cores ram memory tier performance accelerator coreml cuda directml", tab: "voice", anchor: "set-voice-device" },
  { label: "Reset speech engine", keywords: "defaults pipeline", tab: "voice", anchor: "set-voice-reset" },
  { label: "Your voices", keywords: "clone cloning record upload import export delete zipvoice", tab: "voice", anchor: "set-voice-yours" },

  { label: "Coding agents", keywords: "install sign in sign out hide claude codex cursor acp", tab: "agents", anchor: "set-agents-list" },

  { label: "Links", keywords: "github releases changelog issue", tab: "about", anchor: "set-about-links" },
  { label: "Replay tours", keywords: "walkthrough onboarding tips help reset", tab: "about", anchor: "set-about-tours" },
];

/** Every whitespace-separated term must appear in the label, keywords or tab
 *  name. Label hits sort ahead of keyword-only hits; each bucket keeps index
 *  order. One pass over the index: O(n · terms) per query. */
export function searchSettings(query: string, tabLabel: (t: SettingsTabId) => string, desktop: boolean, index = SETTINGS_INDEX): SettingsEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const strong: SettingsEntry[] = [];
  const weak: SettingsEntry[] = [];
  for (const e of index) {
    if (e.desktop && !desktop) continue;
    const label = e.label.toLowerCase();
    const hay = `${label} ${e.keywords ?? ""} ${tabLabel(e.tab)}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    (terms.some((t) => label.includes(t)) ? strong : weak).push(e);
  }
  return strong.concat(weak);
}
