// A frozen copy of the v6 config file as it shipped, with a coding agent as the
// brain and Flow's own Patient wait. A regression test, not a sample: NEVER
// edit it to match a schema change; add a migration and freeze a new fixture.
export const CONFIG_V6_FIXTURE: unknown = Object.freeze({
  version: 6,
  insertion: { method: "paste", modifierHoldMs: 100, clipboardQuietMs: 200, clipboardTimeoutMs: 8000 },
  brain: { kind: "acp", agentId: "claude-code", agentModel: "haiku", agentEffort: "" },
  voice: {
    speakReplies: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
    turn: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 },
  },
  consent: { granted: true, at: "2026-08-01T09:00:00.000Z" },
  idleWindowMs: 300000,
});
