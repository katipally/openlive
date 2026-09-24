import { describe, expect, it } from "vitest";
import { resolveSettingsTab, searchSettings, SETTINGS_INDEX, type SettingsEntry } from "./settingsSearch";

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

  it("every anchor is a settings id", () => {
    for (const e of SETTINGS_INDEX) expect(e.anchor).toMatch(/^set-/);
  });
});

describe("resolveSettingsTab", () => {
  it("keeps current ids and maps merged ones to Voice", () => {
    expect(resolveSettingsTab("models")).toBe("models");
    expect(resolveSettingsTab("pipeline")).toBe("voice");
    expect(resolveSettingsTab("voices")).toBe("voice");
  });
  it("drops unknown or empty ids", () => {
    expect(resolveSettingsTab("nope")).toBeNull();
    expect(resolveSettingsTab(null)).toBeNull();
    expect(resolveSettingsTab("")).toBeNull();
  });
});
