// A frozen copy of the v7 config file as it shipped, on the old 100 ms modifier
// hold, with Dictate set up. A regression test, not a sample: NEVER edit it to
// match a schema change; add a migration and freeze a new fixture.
export const CONFIG_V7_FIXTURE: unknown = Object.freeze({
  version: 7,
  insertion: { method: "paste", modifierHoldMs: 100, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: true },
  brain: { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" },
  voice: {
    speakReplies: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
    turn: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 },
    turnOverride: false,
  },
  consent: { granted: true, at: "2026-09-20T09:00:00.000Z" },
  idleWindowMs: 300000,
  dictate: {
    enabled: true,
    hotkey: "option_right",
    cleanup: { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true },
    brain: { override: false, kind: "api", agentId: "", agentModel: "", agentEffort: "" },
    polish: { enabled: true, tone: "casual" },
    commandHotkey: "shift+option_right",
    commands: { enter: true, newLine: true, newParagraph: true, undo: true, stop: true },
    words: ["OpenLive"],
    snippets: [],
    history: "month",
  },
});
