// A frozen copy of the v8 config file as it shipped, with Dictate on its hold
// keys and Flow kept open 30 minutes. A regression test, not a sample: NEVER
// edit it to match a schema change; add a migration and freeze a new fixture.
export const CONFIG_V8_FIXTURE: unknown = Object.freeze({
  version: 8,
  insertion: { method: "paste", modifierHoldMs: 50, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: true },
  brain: { override: false, kind: "api", agentId: "", agentModel: "", agentEffort: "" },
  voice: {
    speakReplies: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
    turn: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 },
    turnOverride: false,
  },
  consent: { granted: true, at: "2026-09-28T09:00:00.000Z" },
  idleWindowMs: 1800000,
  enabled: false,
  dictate: {
    enabled: true,
    hotkey: "option_right",
    cleanup: { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true },
    brain: { override: false, kind: "api", agentId: "", agentModel: "", agentEffort: "" },
    polish: { enabled: false, tone: "natural" },
    commandHotkey: "shift+option_right",
    commands: { enter: true, newLine: true, newParagraph: true, undo: true, stop: true },
    words: ["OpenLive"],
    snippets: [{ trigger: "my address", text: "221B Baker Street" }],
    history: "week",
  },
});
