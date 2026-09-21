// A frozen copy of the v1 config file as it shipped. It is a regression test, not
// a sample: NEVER edit it to match a schema change. When the schema changes, add a
// migration in config.ts and freeze a new fixture beside this one.
export const CONFIG_V1_FIXTURE: unknown = Object.freeze({
  version: 1,
  binding: "rightalt",
  activation: "hold_or_toggle",
  holdThresholdMs: 250,
  insertion: { method: "paste", modifierHoldMs: 100, clipboardQuietMs: 200, clipboardTimeoutMs: 8000 },
  brain: { kind: "openlive", providerId: "", model: "", agentId: "" },
  voice: {
    speakReplies: true,
    bargeIn: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
  },
  risk: { read: "auto", insert: "auto", control: "ask", destructive: "ask" },
  idleWindowMs: 300000,
  stt: { whisperSize: "base" },
  tts: { engine: "kokoro", voice: "af_heart", speed: 1 },
});
