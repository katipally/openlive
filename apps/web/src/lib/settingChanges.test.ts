import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLOW_CONFIG, type FlowConfig } from "@openlive/flow-store";

const ui = vi.hoisted(() => ({ settingsOpen: false, liveOpen: false, mode: "chat" }));
vi.mock("./uiStore", () => ({ useUi: { getState: () => ui } }));

import { DEFAULT_PIPELINE_CONFIG } from "./live/pipelineConfig";
import {
  flowChanges, flowConfigChanged, flowOnboardingOpen, pipelineChanges, providerKeyChanged, reportSetting,
  seedServerSettings, serverChanges, serverSettingsChanged, settingSurface, SETTING_DEBOUNCE_MS,
} from "./settingChanges";

const flow = (edit: (c: FlowConfig) => void): FlowConfig => {
  const c = structuredClone(DEFAULT_FLOW_CONFIG);
  edit(c);
  return c;
};

describe("serverChanges", () => {
  it("reports custom instructions only as set or cleared, never the text, and not an edit of a set one", () => {
    expect(serverChanges({}, { customInstructions: "be brief" })).toEqual([{ setting: "custom_instructions", value: "set" }]);
    expect(serverChanges({ customInstructions: "be brief" }, { customInstructions: "" })).toEqual([{ setting: "custom_instructions", value: "cleared" }]);
    expect(serverChanges({ customInstructions: "be brief" }, { customInstructions: "be very brief" })).toEqual([]);
    expect(serverChanges({}, { customInstructions: "   " })).toEqual([]);
  });

  it("reports a model as changed or cleared with its provider, never its id", () => {
    const out = serverChanges({ liveProviderId: "openai", liveModel: "gpt-a" }, { liveProviderId: "openai", liveModel: "gpt-b" });
    expect(out).toEqual([{ setting: "api_model", value: "changed", subject: "openai" }]);
    expect(JSON.stringify(out)).not.toContain("gpt");
    expect(serverChanges({ liveProviderId: "openai", liveModel: "gpt-a" }, { liveProviderId: "openai", liveModel: "" }))
      .toEqual([{ setting: "api_model", value: "cleared", subject: "openai" }]);
  });

  it("does not call a model emptied by a provider switch a choice", () => {
    expect(serverChanges({ liveProviderId: "openai", liveModel: "gpt-a" }, { liveProviderId: "groq", liveModel: "" }))
      .toEqual([{ setting: "api_provider", value: "none", subject: "groq" }]);
    expect(serverChanges({ visionProviderId: "openai", visionModel: "v" }, { visionProviderId: "google", visionModel: "" })).toEqual([]);
  });

  it("reports who answers by default as its kind, with the agent and never its model", () => {
    expect(serverChanges({}, { defaultAgent: "codex", defaultAgentModel: "gpt-secret" })).toEqual([{ setting: "default_brain", value: "acp", subject: "codex" }]);
    expect(serverChanges({ defaultAgent: "codex" }, { defaultAgent: "" })).toEqual([{ setting: "default_brain", value: "api", subject: "none" }]);
  });

  it("drops a provider that is not in the closed set", () => {
    expect(serverChanges({}, { liveProviderId: "my-secret-host" })).toEqual([]);
    expect(serverChanges({}, { liveModel: "m", liveProviderId: "my-secret-host" })).toEqual([{ setting: "api_model", value: "changed", subject: "none" }]);
  });

  it("reduces the Ollama address to default, local or remote", () => {
    const at = (url: string) => serverChanges({ ollamaBaseUrl: "http://x" }, { ollamaBaseUrl: url }).map((c) => c.value);
    expect(at("")).toEqual(["default"]);
    expect(at("http://localhost:11434")).toEqual(["local"]);
    expect(at("http://127.0.0.1:9")).toEqual(["local"]);
    expect(at("http://nas.lan:11434")).toEqual(["remote"]);
  });

  it("reports an agent shown or hidden by id, in either direction, and ignores unknown ids", () => {
    expect(serverChanges({}, { "agentHidden:codex": "1" })).toEqual([{ setting: "agent_hidden", value: "on", subject: "codex" }]);
    expect(serverChanges({ "agentHidden:codex": "1" }, {})).toEqual([{ setting: "agent_hidden", value: "off", subject: "codex" }]);
    expect(serverChanges({}, { "agentHidden:my-agent": "1" })).toEqual([]);
  });

  it("maps effort to a known level, and narration to on or off", () => {
    expect(serverChanges({}, { liveEffort: "high" })).toEqual([{ setting: "api_effort", value: "high" }]);
    expect(serverChanges({ liveEffort: "high" }, { liveEffort: "ludicrous" })).toEqual([{ setting: "api_effort", value: "auto" }]);
    expect(serverChanges({}, { narrateProgress: "0" })).toEqual([{ setting: "narrate_progress", value: "off" }]);
    expect(serverChanges({ narrateProgress: "0" }, { narrateProgress: "1" })).toEqual([{ setting: "narrate_progress", value: "on" }]);
    expect(serverChanges({}, { chatHistory: "week" })).toEqual([{ setting: "chat_history_keep", value: "week" }]);
    expect(serverChanges({ chatHistory: "week" }, { chatHistory: "nonsense" })).toEqual([{ setting: "chat_history_keep", value: "forever" }]);
  });

  it("never reports keys the table does not have (project folder, agent commands)", () => {
    expect(serverChanges({}, { agentCwd: "/Users/me/secret", "acpCommand:codex": "codex --x" })).toEqual([]);
  });
});

describe("flowChanges", () => {
  it("reports nothing for a write that changed nothing", () => {
    expect(flowChanges(DEFAULT_FLOW_CONFIG, structuredClone(DEFAULT_FLOW_CONFIG))).toEqual([]);
  });

  it("reports each toggle that flipped, by name", () => {
    const out = flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => {
      c.voice.speakReplies = false;
      c.voice.autoQuiet.systemDnd = false;
      c.consent.granted = true;
      c.insertion.method = "type";
    }));
    expect(out).toEqual(expect.arrayContaining([
      { setting: "flow_speak_replies", value: "off" },
      { setting: "flow_quiet_dnd", value: "off" },
      { setting: "flow_consent", value: "on" },
      { setting: "flow_insertion", value: "type" },
    ]));
    expect(out).toHaveLength(4);
  });

  it("names the effective brain, an agent by id, and leaves model and effort out", () => {
    const out = flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => {
      c.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "gpt-x", agentEffort: "high" };
    }));
    expect(out).toEqual([
      { setting: "flow_own_brain", value: "on" },
      { setting: "flow_brain", value: "acp", subject: "codex" },
    ]);
    expect(flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => { c.brain.agentModel = "other"; c.brain.agentEffort = "low"; }))).toEqual([]);
  });

  it("maps Close after silence to its four choices, else custom", () => {
    const at = (ms: number | null) => flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => { c.talk.closeAfterSilenceMs = ms; })).map((c) => c.value);
    expect(at(90_000)).toEqual(["90s"]);
    expect(at(300_000)).toEqual(["5m"]);
    expect(at(null)).toEqual(["never"]);
    expect(at(123_456)).toEqual(["custom"]);
    expect(at(30_000)).toEqual([]);
  });

  it("reports how you talk, and the push-to-talk key only as a default or another", () => {
    const at = (edit: (c: FlowConfig) => void) => flowChanges(DEFAULT_FLOW_CONFIG, flow(edit));
    expect(at((c) => { c.talk.mode = "ptt"; })).toEqual([{ setting: "talk_mode", value: "ptt" }]);
    expect(at((c) => { c.talk.mode = null; })).toEqual([]);
    expect(at((c) => { c.talk.pttKey = c.talk.pttKey === "fn" ? "ctrl_right" : "fn"; })).toEqual([{ setting: "ptt_key", value: expect.stringMatching(/^(fn|ctrl_right)$/) }]);
    expect(at((c) => { c.talk.pttKey = "f18"; })).toEqual([{ setting: "ptt_key", value: "other" }]);
  });

  it("reports Dictate's switch, polish, tone, its own brain and both keys, a key by group or other", () => {
    const at = (edit: (c: FlowConfig) => void) => flowChanges(DEFAULT_FLOW_CONFIG, flow(edit));
    expect(at((c) => { c.dictate.enabled = true; c.dictate.polish = { enabled: true, tone: "formal" }; })).toEqual([
      { setting: "dictate_enabled", value: "on" }, { setting: "dictate_polish", value: "on" }, { setting: "dictate_tone", value: "formal" },
    ]);
    expect(at((c) => { c.dictate.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" }; })).toEqual([
      { setting: "dictate_own_brain", value: "on" }, { setting: "dictate_brain", value: "acp", subject: "codex" },
    ]);
    // Following Flow, Dictate's brain moves with Flow's, which flow_brain reports once.
    expect(at((c) => { c.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" }; }).map((x) => x.setting)).toEqual(["flow_own_brain", "flow_brain"]);
    expect(at((c) => { c.talk.flowKey = "shift"; c.talk.dictateKey = "option_right"; })).toEqual([
      { setting: "flow_key", value: "shift" }, { setting: "dictate_key", value: "other" },
    ]);
  });

  it("reports how long Flow and Dictate keep their history", () => {
    expect(flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => { c.history = "week"; c.dictate.history = "off"; }))).toEqual([
      { setting: "flow_history_keep", value: "week" }, { setting: "dictate_history_keep", value: "off" },
    ]);
  });

  it("reports Flow's own wait, and which preset the new values are", () => {
    const out = flowChanges(DEFAULT_FLOW_CONFIG, flow((c) => {
      c.voice.turnOverride = true;
      c.voice.turn = { threshold: 0.35, holdMs: 2500, redemptionMs: 350 };
    }));
    expect(out).toEqual([{ setting: "flow_own_wait", value: "on" }, { setting: "wait_preset", value: "quick" }]);
  });
});

describe("pipelineChanges", () => {
  const cfg = DEFAULT_PIPELINE_CONFIG;

  it("reports the engines, language, voiceprint, side talk and restricted OK that changed", () => {
    const out = pipelineChanges(cfg, {
      ...cfg,
      voiceprint: "gate",
      sideTalk: "ignore",
      allowRestricted: true,
      tts: { ...cfg.tts, family: "piper" },
    });
    expect(out).toEqual(expect.arrayContaining([
      { setting: "tts_family", value: "piper" },
      { setting: "voiceprint", value: "gate" },
      { setting: "side_talk", value: "ignore" },
      { setting: "allow_restricted", value: "on" },
    ]));
    expect(out).toHaveLength(4);
  });

  it("counts a language change once, not the engines it swapped with it", () => {
    expect(pipelineChanges(cfg, { ...cfg, language: "es", stt: { ...cfg.stt, family: "nemotron" }, tts: { ...cfg.tts, family: "piper" } }))
      .toEqual([{ setting: "language", value: "es" }]);
  });

  it("does not report a voice, a speed or a pronunciation", () => {
    expect(pipelineChanges(cfg, { ...cfg, tts: { ...cfg.tts, voice: "am_adam", speed: 1.4 }, pronunciations: [{ from: "Yash", to: "Yush" }] as never })).toEqual([]);
  });

  it("names the wait preset the shared values now match", () => {
    const out = pipelineChanges(cfg, { ...cfg, vad: { ...cfg.vad, redemptionMs: 800 }, turn: { ...cfg.turn, threshold: 0.65, holdMs: 6000 } });
    expect(out).toEqual([{ setting: "wait_preset", value: "patient" }]);
    expect(pipelineChanges(cfg, { ...cfg, vad: { ...cfg.vad, redemptionMs: 500 } })).toEqual([{ setting: "wait_preset", value: "custom" }]);
  });
});

describe("the reporter", () => {
  const track = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    track.mockClear();
    ui.settingsOpen = false; ui.liveOpen = false; ui.mode = "chat";
    flowOnboardingOpen(false);
    (globalThis as { window?: unknown }).window = { openlive: { telemetry: { track } } };
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { window?: unknown }).window; });

  it("sends one event per setting after it has been still, carrying the last value", () => {
    ui.settingsOpen = true;
    for (const v of ["quick", "even", "patient"] as const) {
      reportSetting({ setting: "wait_preset", value: v });
      vi.advanceTimersByTime(SETTING_DEBOUNCE_MS - 100);
    }
    expect(track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("setting_changed", { setting: "wait_preset", value: "patient", from: "settings" });
  });

  it("debounces each setting on its own, and each agent on its own", () => {
    reportSetting({ setting: "language", value: "fr" });
    reportSetting({ setting: "agent_hidden", value: "on", subject: "codex" });
    reportSetting({ setting: "agent_hidden", value: "on", subject: "cursor" });
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it("names the screen the change was made from, read when it was made", () => {
    expect(settingSurface()).toBe("other");
    ui.mode = "flow";
    expect(settingSurface()).toBe("flow_home");
    ui.liveOpen = true;
    expect(settingSurface()).toBe("call_setup");
    flowOnboardingOpen(true);
    expect(settingSurface()).toBe("onboarding");
    ui.settingsOpen = true;
    expect(settingSurface()).toBe("settings");
    reportSetting({ setting: "language", value: "de" });
    ui.settingsOpen = false;
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).toHaveBeenCalledWith("setting_changed", expect.objectContaining({ from: "settings" }));
  });

  it("reports server settings only against a baseline, then only what differs", () => {
    serverSettingsChanged({ narrateProgress: "0" });
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).not.toHaveBeenCalled();
    seedServerSettings({ narrateProgress: "0" });
    serverSettingsChanged({ narrateProgress: "0" });
    serverSettingsChanged({ narrateProgress: "1" });
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("setting_changed", { setting: "narrate_progress", value: "on", from: "other" });
  });

  it("skips a settle write, and marks consent once", () => {
    const before = flow(() => {});
    const after = flow((c) => { c.consent.granted = true; });
    flowConfigChanged(before, after, true);
    flowConfigChanged(undefined, after);
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).not.toHaveBeenCalled();
    flowConfigChanged(before, after);
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).toHaveBeenCalledWith("onboarding_step", { step: "flow_consent_granted" });
    expect(track).toHaveBeenCalledWith("setting_changed", { setting: "flow_consent", value: "on", from: "other" });
  });

  it("reports a provider key by provider only, and marks the first one saved", () => {
    providerKeyChanged("openai", "added");
    providerKeyChanged("not-a-provider", "added");
    vi.advanceTimersByTime(SETTING_DEBOUNCE_MS);
    expect(track).toHaveBeenCalledWith("onboarding_step", { step: "first_provider_key_saved" });
    expect(track).toHaveBeenCalledWith("setting_changed", { setting: "provider_key", value: "added", subject: "openai", from: "other" });
    expect(track).toHaveBeenCalledTimes(2);
  });
});
