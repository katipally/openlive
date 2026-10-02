import { describe, expect, it } from "vitest";
import { CAPABILITY_TABS, capabilityReveal, capabilityTab, resolveSettingsTab, searchSettings, SETTINGS_INDEX, type SettingsEntry } from "./settingsSearch";

const label = (t: string) => t[0]!.toUpperCase() + t.slice(1);
const find = (q: string, desktop = true, index?: SettingsEntry[]) => searchSettings(q, label, desktop, index).map((e) => e.label);

describe("settings search", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(find("")).toEqual([]);
    expect(find("   ")).toEqual([]);
  });

  it("matches labels and keywords, case-insensitively", () => {
    expect(find("SPEAKING")).toContain("Speaking speed");
    expect(find("whisper")).toEqual(["Speech-to-text"]);
  });

  it("finds the speech engines by name and by what they do", () => {
    for (const q of ["nemotron", "parakeet", "moonshine", "streaming", "speech recognition engine"]) expect(find(q)).toEqual(["Speech-to-text"]);
    for (const q of ["pocket", "kitten"]) expect(find(q)).toEqual(["Text-to-speech"]);
    for (const q of ["silero v6", "vad model"]) expect(find(q)).toEqual(["Voice activity detection"]);
  });

  it("finds the language picker by any curated language, in English or its own name", () => {
    for (const q of ["language", "spanish", "español", "espanol", "japanese", "日本語", "한국어", "हिन्दी", "chinese", "中文", "français", "deutsch"]) {
      expect(find(q)).toContain("Language");
    }
  });

  it("finds every engine family and its notable variants", () => {
    for (const q of ["canary", "fp16", "80ms", "1120ms", "nemotron 3.5", "parakeet v3", "moonshine tiny"]) expect(find(q)).toEqual(["Speech-to-text"]);
    for (const q of ["piper", "matcha", "kokoro cpu", "thorsten", "kitten mini", "fp32", "huayan"]) expect(find(q)).toEqual(["Text-to-speech"]);
  });

  it("finds where restricted-license models are allowed", () => {
    for (const q of ["restricted", "non-commercial", "license"]) expect(find(q)).toContain("Text-to-speech");
  });

  it("finds the pronunciation dictionary by what people call it", () => {
    for (const q of ["pronunciation", "mispronounced", "respell"]) expect(find(q)).toEqual(["Pronunciation"]);
    // Dictate's dictionary is the other one.
    expect(find("dictionary")).toEqual(["Dictionary", "Pronunciation"]);
  });

  it("a Dictate row opens its subtab first", () => {
    for (const e of SETTINGS_INDEX.filter((x) => x.tab === "dictate")) expect(e.reveal).toMatch(/^set-dictate-(basics|words|commands|history)$/);
  });

  it("needs every term, in any order", () => {
    expect(find("speed speaking")).toEqual(["Speaking speed"]);
    expect(find("whisper kokoro")).toEqual([]);
  });

  it("matches the tab name too", () => {
    expect(find("about")).toContain("Links");
  });

  it("ranks label hits ahead of keyword-only hits", () => {
    const index: SettingsEntry[] = [
      { label: "Alpha", keywords: "voice", tab: "general", anchor: "a" },
      { label: "Voice thing", tab: "general", anchor: "b" },
    ];
    expect(find("voice", true, index)).toEqual(["Voice thing", "Alpha"]);
  });

  it("hides desktop-only rows outside the desktop app", () => {
    expect(find("login", true)).toContain("Open at login");
    expect(find("login", false)).not.toContain("Open at login");
  });

  it("finds the screen lock row by what people call it, in the desktop app only", () => {
    for (const q of ["lock", "screen lock", "locked", "sleep", "hang up"]) expect(find(q)).toContain("End Flow and calls when the screen locks");
    expect(find("lock", false)).not.toContain("End Flow and calls when the screen locks");
    expect(SETTINGS_INDEX.find((e) => e.anchor === "set-general-lock")!.tab).toBe("general");
  });

  it("leaves the screen lock row out of a Linux desktop, where the OS never reports a lock", () => {
    const at = (os: string) => searchSettings("screen locks", label, true, undefined, os).map((e) => e.label);
    expect(at("linux")).not.toContain("End Flow and calls when the screen locks");
    for (const os of ["darwin", "win32", ""]) expect(at(os)).toContain("End Flow and calls when the screen locks");
  });

  it("finds the one shared wait by its new names and its old ones", () => {
    for (const q of ["patient", "quick", "snappy", "relaxed"]) expect(find(q)[0]).toBe("Wait before answering");
    expect(find("wait")).toEqual(["Wait before answering", "Flow's own wait"]);
  });

  it("files call-only rows under Chat and the engine under Speech engine", () => {
    expect(SETTINGS_INDEX.find((e) => e.label === "Push-to-talk")!.tab).toBe("chat");
    expect(SETTINGS_INDEX.find((e) => e.label === "Speech-to-text")!.tab).toBe("engine");
    expect(SETTINGS_INDEX.find((e) => e.label === "Listening sounds")!.tab).toBe("voice");
  });

  it("finds typing at the cursor under General, where Flow and Dictate share it", () => {
    for (const q of ["typing", "paste", "clipboard", "how text goes in", "type it out"]) expect(find(q)).toContain("Typing at cursor");
    const rows = SETTINGS_INDEX.filter((e) => e.label === "Typing at cursor" || e.anchor === "set-flow-typing");
    expect(rows.map((e) => [e.tab, e.anchor])).toEqual([["general", "set-general-typing"]]);
  });

  it("every anchor is a settings id", () => {
    for (const e of SETTINGS_INDEX) expect(e.anchor).toMatch(/^set-/);
  });

  it("a row inside a speech engine stage has its own anchor and opens its stage first", () => {
    const staged = SETTINGS_INDEX.filter((e) => e.reveal && e.tab !== "capabilities" && e.tab !== "dictate");
    expect(staged.map((e) => e.label)).toEqual(expect.arrayContaining(["Voiceprint", "Side talk"]));
    for (const e of staged) {
      expect(e.tab).toBe("engine");
      expect(e.reveal).toMatch(/^set-engine-stage-(mic|stt|turn|tts)$/);
      expect(SETTINGS_INDEX.filter((o) => o.anchor === e.anchor)).toHaveLength(1);
    }
  });
});

describe("capabilities settings", () => {
  it("indexes every subtab, each row opening its subtab first", () => {
    const rows = SETTINGS_INDEX.filter((e) => e.tab === "capabilities");
    expect(new Set(rows.map((e) => e.reveal))).toEqual(new Set(CAPABILITY_TABS.map(capabilityReveal)));
    for (const e of rows) expect(e.anchor.startsWith(`${e.reveal}-`) || e.anchor.startsWith("set-capabilities-")).toBe(true);
  });

  it("finds each subtab by its old page's words", () => {
    expect(find("mcp")).toContain("Connectors");
    expect(find("skill.md")).toEqual(["Skills"]);
    expect(find("shell")).toContain("Tools");
    expect(find("exa")).toEqual(["Web search key"]);
  });
});

describe("privacy settings", () => {
  it("are found by what people call them, in the desktop app only", () => {
    for (const q of ["telemetry", "analytics", "opt out", "privacy"]) expect(find(q)).toContain("Share anonymous usage");
    expect(find("uuid")).toEqual(["Install ID"]);
    expect(find("bug")).toEqual(["Report a problem"]);
    for (const q of ["delete my data", "gdpr", "erase"]) expect(find(q)).toContain("Request deletion");
    expect(find("telemetry", false)).toEqual([]);
    expect(find("report", false)).not.toContain("Report a problem");
  });

  it("file every row under the Privacy tab", () => {
    const rows = SETTINGS_INDEX.filter((e) => e.tab === "privacy");
    expect(rows.map((e) => e.label)).toEqual(["Share anonymous usage", "What is shared", "Privacy policy", "Ask for feedback", "Install ID", "Your anonymous name", "Request deletion", "Report a problem"]);
    for (const e of rows) expect(e.desktop).toBe(true);
  });
});

describe("resolveSettingsTab", () => {
  it("keeps current ids and maps old ones to the tab that holds them now", () => {
    expect(resolveSettingsTab("models")).toBe("models");
    for (const id of ["engine", "chat", "flow", "dictate", "voice", "privacy"]) expect(resolveSettingsTab(id)).toBe(id);
    expect(resolveSettingsTab("pipeline")).toBe("engine");
    expect(resolveSettingsTab("voices")).toBe("voice");
  });
  it("lands the old Connectors and Skills pages, the orb's links included, on their Capabilities subtab", () => {
    for (const id of ["tools", "skills", "connectors", "capabilities"]) expect(resolveSettingsTab(id)).toBe("capabilities");
    expect(capabilityTab("connectors")).toBe("connectors");
    expect(capabilityTab("skills")).toBe("skills");
    expect(capabilityTab("capabilities")).toBeNull();
    expect(capabilityTab(/^([a-z]+)-settings$/.exec("connectors-settings")?.[1])).toBe("connectors");
  });
  it("drops unknown or empty ids", () => {
    expect(resolveSettingsTab("nope")).toBeNull();
    expect(resolveSettingsTab(null)).toBeNull();
    expect(resolveSettingsTab("")).toBeNull();
  });
});
