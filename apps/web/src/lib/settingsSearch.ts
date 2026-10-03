// Settings search, the pure half: every searchable row, where it lives, and how a
// query narrows them. No React, no DOM, so it tests on its own.

import { CURATED_LANGUAGES, STT_FAMILIES, TTS_FAMILIES, type EngineFamilyInfo } from "./live/pipelineConfig";

export type SettingsTabId = "general" | "flow" | "dictate" | "chat" | "models" | "agents" | "capabilities" | "memory" | "voice" | "engine" | "privacy" | "about";

/** The subtabs of Capabilities. Each was, or could have been, a tab of its own. */
export const CAPABILITY_TABS = ["tools", "skills", "connectors"] as const;
export type CapabilityTab = (typeof CAPABILITY_TABS)[number];

export const SETTINGS_TABS: readonly string[] = ["general", "flow", "dictate", "chat", "models", "agents", "capabilities", "memory", "voice", "engine", "privacy", "about"] satisfies SettingsTabId[];
// Tabs that were merged away. A deep link or anything persisted with an old id
// still lands on the tab that holds its content now.
const LEGACY_TABS: Record<string, SettingsTabId> = { pipeline: "engine", voices: "voice", tools: "capabilities", skills: "capabilities", connectors: "capabilities" };

export function resolveSettingsTab(id: string | null | undefined): SettingsTabId | null {
  if (!id) return null;
  if (SETTINGS_TABS.includes(id)) return id as SettingsTabId;
  return LEGACY_TABS[id] ?? null;
}

/** The Capabilities subtab a deep link names ("connectors", "skills"), or null. */
export const capabilityTab = (id: string | null | undefined): CapabilityTab | null =>
  CAPABILITY_TABS.find((t) => t === id) ?? null;

/** The subtab's own button, which a search result clicks first. */
export const capabilityReveal = (t: CapabilityTab) => `set-capabilities-${t}`;

export interface SettingsEntry {
  label: string;
  /** Other words a person might type for this row. */
  keywords?: string;
  tab: SettingsTabId;
  /** DOM id of the row (or its section) to scroll to. */
  anchor: string;
  /** DOM id of the stage tab or subtab that holds the row, clicked first.
   *  A row folded under Advanced is unfolded on the way. */
  reveal?: string;
  /** Only rendered in the desktop app. */
  desktop?: boolean;
  /** Only rendered when the desktop OS is one of these ("darwin", "win32", "linux"). */
  os?: readonly string[];
}

/** Each family's name and the parts of its variant ids ("80ms", "fp16",
 *  "thorsten"), so every engine and preset is found by the name it shows. */
const engineWords = (families: EngineFamilyInfo[]) =>
  [...new Set(families.flatMap((f) => [f.name, ...f.variants.map((v) => v.id)]).flatMap((s) => s.toLowerCase().split(/[\s()_-]+/)))].join(" ");
/** Each language in English, in its own name, and in its own name without accents ("espanol"). */
const LANGUAGE_WORDS = CURATED_LANGUAGES.flatMap((l) => [l.name, l.native, l.native.normalize("NFD").replace(/[\u0300-\u036f]/g, "")]).join(" ");

export const SETTINGS_INDEX: SettingsEntry[] = [
  { label: "Appearance", keywords: "theme dark light system mode look glass flat transparency blur", tab: "general", anchor: "set-general-appearance" },
  { label: "Assistant style", keywords: "your assistant's custom instructions prompt tone behave", tab: "general", anchor: "set-general-style" },
  { label: "Keyboard shortcuts", keywords: "keys hotkeys", tab: "general", anchor: "set-general-shortcuts" },
  { label: "Open at login", keywords: "startup launch boot background", tab: "general", anchor: "set-general-startup", desktop: true },
  { label: "End Flow and calls when the screen locks", keywords: "lock locked sleep suspend keep going close hang up", tab: "general", anchor: "set-general-lock", desktop: true, os: ["darwin", "win32"] },
  { label: "Typing at cursor", keywords: "how text goes in paste type it out typing insertion insert clipboard put back restore timing modifier dictate flow", tab: "general", anchor: "set-general-typing" },
  { label: "Put my clipboard back", keywords: "restore clipboard keep pasted text paste copy", tab: "general", anchor: "set-general-clipboard" },
  { label: "Dictate on or off", keywords: "dictation turn on off enable disable voice typing speech to text", tab: "dictate", anchor: "set-dictate-status", reveal: "set-dictate-basics", desktop: true },
  { label: "Dictate hotkey", keywords: "hold to talk push to talk key right alt option altgr change shortcut hands-free double tap", tab: "dictate", anchor: "set-dictate-trigger", reveal: "set-dictate-basics", desktop: true },
  { label: "Dictation cleanup", keywords: "punctuation capitals fillers um uh backtrack scratch that actually correction lists numbers digits", tab: "dictate", anchor: "set-dictate-cleanup", reveal: "set-dictate-basics" },
  { label: "AI polish", keywords: "dictate rewrite polish grammar tone natural casual formal professional brain", tab: "dictate", anchor: "set-dictate-polish", reveal: "set-dictate-basics" },
  { label: "Who answers for AI polish and commands", keywords: "dictate brain agent model api key coding agent its own different override same as flow", tab: "dictate", anchor: "set-dictate-brain", reveal: "set-dictate-basics" },
  { label: "Dictionary", keywords: "dictate words names jargon spelling custom vocabulary terms", tab: "dictate", anchor: "set-dictate-dictionary", reveal: "set-dictate-words" },
  { label: "Snippets", keywords: "dictate text expansion shortcut phrase trigger template address signature", tab: "dictate", anchor: "set-dictate-snippets", reveal: "set-dictate-words" },
  { label: "Command mode", keywords: "dictate edit selection selected text rewrite translate make formal shift hotkey instruction", tab: "dictate", anchor: "set-dictate-command", reveal: "set-dictate-commands", desktop: true },
  { label: "Spoken commands", keywords: "dictate press enter return new line paragraph undo that stop dictating voice commands", tab: "dictate", anchor: "set-dictate-spoken", reveal: "set-dictate-commands" },
  { label: "Dictate history", keywords: "dictations past transcripts recent keep retention days clear all delete", tab: "dictate", anchor: "set-dictate-history", reveal: "set-dictate-basics" },

  { label: "Who answers you", keywords: "default brain who thinks api key coding agent claude code codex cursor new chats flow dictate", tab: "models", anchor: "set-models-default" },
  { label: "Provider & API key", keywords: "byok key openai anthropic paste remove default", tab: "models", anchor: "set-models-provider" },
  { label: "Model", keywords: "llm live model vision reasoning default", tab: "models", anchor: "set-models-model" },
  { label: "Vision model", keywords: "camera screen images see", tab: "models", anchor: "set-models-vision" },
  { label: "Reasoning effort", keywords: "thinking speed latency", tab: "models", anchor: "set-models-effort" },

  { label: "Language", keywords: `${LANGUAGE_WORDS} speak reply multilingual translate`, tab: "voice", anchor: "set-voice-language" },
  { label: "Voice", keywords: "speaker who speaks answers preview sample listen female male accent american british pick", tab: "voice", anchor: "set-voice-voice" },
  { label: "Speaking speed", keywords: "rate tts fast slow", tab: "voice", anchor: "set-voice-speaking" },
  { label: "Wait before answering", keywords: "pace turn patient even quick relaxed balanced snappy end of turn interrupt cut off", tab: "voice", anchor: "set-voice-wait" },
  { label: "Listening sounds", keywords: "experimental backchannel backchannels mm-hmm uh-huh yeah listener active listening cue pause", tab: "voice", anchor: "set-voice-listening-sounds" },
  { label: "Pronunciation", keywords: "dictionary lexicon respell pronounce say read aloud name brand word mispronounced numbers", tab: "voice", anchor: "set-voice-pronunciation" },
  { label: "Your voices", keywords: "clone cloning record upload import export delete zipvoice", tab: "voice", anchor: "set-voice-yours" },

  { label: "Voice activity detection", keywords: "vad silero v6 v5 model sensitivity trailing silence", tab: "engine", anchor: "set-engine-stage-mic" },
  { label: "Voiceprint", keywords: "experimental speaker verification only me my voice enroll enrollment other people room voices ignore label speakers diarization who is speaking echo barge-in", tab: "engine", anchor: "set-engine-voiceprint", reveal: "set-engine-stage-mic" },
  { label: "Speech-to-text", keywords: `stt whisper model size transcription speech recognition engine streaming native download variant latency runs on cpu coreml cuda directml accelerator threads benchmark ${engineWords(STT_FAMILIES)}`, tab: "engine", anchor: "set-engine-stage-stt" },
  { label: "Turn-taking", keywords: "smart-turn end of turn detector silence timeout threshold mid-thought hold", tab: "engine", anchor: "set-engine-stage-turn" },
  { label: "Side talk", keywords: "experimental addressee talking to someone else other people room ignore not for me not for you device directed family kids phone call aside shadow judge only judgment log train personal head", tab: "engine", anchor: "set-engine-side-talk", reveal: "set-engine-stage-turn" },
  { label: "Text-to-speech", keywords: `tts kokoro supertonic pocket kitten engine native download variant runs on cpu coreml cuda directml accelerator threads benchmark license restricted non-commercial allow locked ${engineWords(TTS_FAMILIES)}`, tab: "engine", anchor: "set-engine-stage-tts" },
  { label: "This device", keywords: "hardware cpu gpu cores ram memory tier performance accelerator coreml cuda directml", tab: "engine", anchor: "set-engine-device" },
  { label: "Reset speech engine", keywords: "defaults pipeline", tab: "engine", anchor: "set-engine-reset" },

  { label: "Coding agents", keywords: "install sign in sign out hide claude codex cursor acp", tab: "agents", anchor: "set-agents-list" },

  { label: "Tools", keywords: "built-in builtin tools computer use screen click files folder web research search fetch text type clipboard selection assistant todos shell command terminal turn off disable groups", tab: "capabilities", anchor: "set-capabilities-tools-list", reveal: capabilityReveal("tools") },
  { label: "Load connector tools on demand", keywords: "auto on off lazy prompt size many connectors tools find_tools use_tool", tab: "capabilities", anchor: "set-capabilities-on-demand", reveal: capabilityReveal("tools") },
  { label: "Skills", keywords: "agent skills skill.md instructions slash command new create edit folder built-in", tab: "capabilities", anchor: "set-capabilities-skills-list", reveal: capabilityReveal("skills") },
  { label: "Import skills", keywords: "skills import claude code codex gemini agents copy", tab: "capabilities", anchor: "set-capabilities-skills-list", reveal: capabilityReveal("skills") },
  { label: "Connectors", keywords: "mcp servers tools plugins integrations add url json oauth sign in github slack notion", tab: "capabilities", anchor: "set-capabilities-connectors-list", reveal: capabilityReveal("connectors") },
  { label: "Import connectors", keywords: "mcp import claude desktop claude code codex cursor gemini vs code vscode mcpServers", tab: "capabilities", anchor: "set-capabilities-connectors-list", reveal: capabilityReveal("connectors") },
  { label: "Web search key", keywords: "exa api key web search rate limit free tier built-in connector", tab: "capabilities", anchor: "set-capabilities-exa", reveal: capabilityReveal("connectors") },
  { label: "Memory", keywords: "remember notes facts forget delete clear edit add budget prompt saved what it knows about me", tab: "memory", anchor: "set-memory-list" },

  { label: "Push-to-talk", keywords: "hold to talk tap to toggle space walkie voice input call", tab: "chat", anchor: "set-chat-ptt" },
  { label: "Narrate agent progress", keywords: "spoken steps plan voice call", tab: "chat", anchor: "set-chat-narrate" },

  { label: "Flow on or off", keywords: "listen for the flow hotkey armed disarm pause turn off on enable disable control ctrl double tap trigger gesture", tab: "flow", anchor: "set-flow-status", desktop: true },
  { label: "Who answers in Flow", keywords: "brain agent model api key coding agent who thinks its own different override same as default", tab: "flow", anchor: "set-flow-brain" },
  { label: "Say replies out loud", keywords: "speak voice", tab: "flow", anchor: "set-flow-voice" },
  { label: "Flow's own wait", keywords: "wait before answering pace turn patient even quick different override", tab: "flow", anchor: "set-flow-wait" },
  { label: "Stay open after the last reply", keywords: "idle timeout close", tab: "flow", anchor: "set-flow-voice" },
  { label: "Go quiet when", keywords: "meeting mic do not disturb dnd silent text", tab: "flow", anchor: "set-flow-quiet" },
  { label: "Access", keywords: "permissions microphone accessibility screen recording consent computer use helper", tab: "flow", anchor: "set-flow-access" },

  { label: "Share anonymous usage", keywords: "telemetry analytics usage data tracking diagnostics opt out collect send privacy", tab: "privacy", anchor: "set-privacy-usage", desktop: true },
  { label: "What is shared", keywords: "events list telemetry data collected transparency", tab: "privacy", anchor: "set-privacy-usage", desktop: true },
  { label: "Privacy policy", keywords: "legal gdpr terms data protection policy", tab: "privacy", anchor: "set-privacy-data", desktop: true },
  { label: "Ask for feedback", keywords: "survey rating nps thumbs prompt questions stop asking don't ask again", tab: "privacy", anchor: "set-privacy-usage", desktop: true },
  { label: "Install ID", keywords: "uuid", tab: "privacy", anchor: "set-privacy-usage", desktop: true },
  { label: "Your anonymous name", keywords: "username random profile identifier install id", tab: "privacy", anchor: "set-privacy-usage", desktop: true },
  { label: "Request deletion", keywords: "delete erase remove my data gdpr ccpa right to be forgotten privacy email", tab: "privacy", anchor: "set-privacy-data", desktop: true },
  { label: "Report a problem", keywords: "bug issue github feedback broken help", tab: "privacy", anchor: "set-privacy-report", desktop: true },

  { label: "Your data", keywords: "openlive folder data location path open reset erase delete start over local", tab: "about", anchor: "set-about-data" },
  { label: "Links", keywords: "github releases changelog issue", tab: "about", anchor: "set-about-links" },
  { label: "Replay tours", keywords: "walkthrough onboarding tips help reset", tab: "about", anchor: "set-about-tours" },
];

/** Whether `a` becomes `b` with at most one letter added, dropped, changed or
 *  two neighbours swapped ("memmory", "dicate", "pirvacy"). O(length). */
function oneEditAway(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const rest = (x: number, y: number) => a.slice(x) === b.slice(y);
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
}

/** Every whitespace-separated term must appear in the label, keywords or tab
 *  name. Label hits sort ahead of keyword-only hits; each bucket keeps index
 *  order. When nothing matches, a term of four letters or more also matches a
 *  word one typo away. One pass over the index, two at most: O(n · terms · words). */
export function searchSettings(query: string, tabLabel: (t: SettingsTabId) => string, desktop: boolean, index = SETTINGS_INDEX, os = ""): SettingsEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const pass = (typos: boolean) => {
    const strong: SettingsEntry[] = [];
    const weak: SettingsEntry[] = [];
    for (const e of index) {
      if (e.desktop && !desktop) continue;
      if (e.os && os && !e.os.includes(os)) continue;
      const label = e.label.toLowerCase();
      const hay = `${label} ${e.keywords ?? ""} ${tabLabel(e.tab)}`.toLowerCase();
      const words = typos ? hay.split(/[^\p{L}\p{N}]+/u) : [];
      const has = (t: string, text: string, ws: string[]) => text.includes(t) || (t.length >= 4 && ws.some((w) => oneEditAway(t, w)));
      if (!terms.every((t) => has(t, hay, words))) continue;
      const labelWords = typos ? label.split(/[^\p{L}\p{N}]+/u) : [];
      (terms.some((t) => has(t, label, labelWords)) ? strong : weak).push(e);
    }
    return strong.concat(weak);
  };
  const exact = pass(false);
  return exact.length ? exact : pass(true);
}
