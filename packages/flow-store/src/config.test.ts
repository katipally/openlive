import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CONFIG_V1_FIXTURE } from "./config.v1.fixture";
import { CONFIG_V6_FIXTURE } from "./config.v6.fixture";
import { CONFIG_V7_FIXTURE } from "./config.v7.fixture";
import { defaultBrain, defaultBrainSettings, dictateBrain, flowBrain, flowTurn } from "./shared";
import { DEFAULT_FLOW_CONFIG, FLOW_CONFIG_VERSION, parseFlowConfig, readFlowConfig, updateFlowConfig } from "./config";
import { configPath, ensureDir, flowDir } from "./paths";

const dir = mkdtempSync(join(tmpdir(), "flow-config-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; ensureDir(flowDir()); });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

test("the frozen v1 fixture still loads", () => {
  // If this needs editing to pass, the schema changed: add a migration instead.
  const cfg = parseFlowConfig(CONFIG_V1_FIXTURE);
  expect(cfg.version).toBe(FLOW_CONFIG_VERSION);
  expect(cfg.insertion.method).toBe("paste");
  expect(cfg.insertion.clipboardTimeoutMs).toBe(8000);
  expect(cfg.brain.kind).toBe("api");
  expect(cfg.voice.autoQuiet.micContention).toBe(true);
  expect(cfg.idleWindowMs).toBe(300000);
  // v2 has one gesture, v3 has one permission and v6 shares the voice pipeline,
  // so the fields that used to configure the trigger, the risk tiers and Flow's
  // own speech are dropped on the way through rather than left behind as dead
  // settings.
  for (const gone of ["binding", "activation", "holdThresholdMs", "risk", "toolRisk", "stt", "tts"]) {
    expect(cfg).not.toHaveProperty(gone);
  }
  expect(cfg.consent).toEqual({ granted: false, at: "" });
});

test("a v3 brain called \"openlive\" loads as API mode, and an agent brain is left alone", () => {
  expect(parseFlowConfig({ version: 3, brain: { kind: "openlive" } }).brain.kind).toBe("api");
  expect(parseFlowConfig({ version: 3, brain: { kind: "acp", agentId: "codex" } }).brain.kind).toBe("acp");
});

test("a v4 brain's own API-mode pick is dropped, because Flow now uses Chat's", () => {
  const brain = parseFlowConfig({
    version: 4,
    brain: { kind: "api", providerId: "groq", model: "m", effort: "high", agentId: "codex", agentModel: "x", agentEffort: "low" },
  }).brain;
  expect(brain).toEqual({ override: false, kind: "api", agentId: "codex", agentModel: "x", agentEffort: "low" });
});

test("nothing fails the parse", () => {
  expect(parseFlowConfig(undefined)).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig("not an object")).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig([1, 2, 3])).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig({})).toEqual(DEFAULT_FLOW_CONFIG);
});

test("missing and invalid keys fall back per field, not per file", () => {
  const cfg = parseFlowConfig({
    insertion: { method: "type" },
    consent: { granted: "yes", at: 7 },
    idleWindowMs: -1,
  });
  expect(cfg.insertion.method).toBe("type");
  expect(cfg.insertion.modifierHoldMs).toBe(DEFAULT_FLOW_CONFIG.insertion.modifierHoldMs);
  expect(cfg.idleWindowMs).toBe(DEFAULT_FLOW_CONFIG.idleWindowMs);
  expect(cfg.consent).toEqual(DEFAULT_FLOW_CONFIG.consent);
});

test("a newer build's keys survive an older build's write", async () => {
  writeFileSync(configPath(), JSON.stringify({
    version: FLOW_CONFIG_VERSION,
    futureField: { deep: [1, 2] },
    voice: { futureVoiceKey: "keep me" },
  }));
  const loaded = readFlowConfig() as unknown as Record<string, unknown>;
  expect(loaded.futureField).toEqual({ deep: [1, 2] });

  await updateFlowConfig((c) => ({ ...c, idleWindowMs: 400_000 }));
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  expect(onDisk.futureField).toEqual({ deep: [1, 2] });
  expect(onDisk.voice.futureVoiceKey).toBe("keep me");
  expect(onDisk.voice.speakReplies).toBe(true);
  expect(onDisk.idleWindowMs).toBe(400_000);
});

test("updateFlowConfig holds the lock across the whole read-modify-write", async () => {
  await updateFlowConfig((c) => ({ ...c, idleWindowMs: 1 }));
  const N = 20;
  await Promise.all(Array.from({ length: N }, () => updateFlowConfig(async (c) => {
    await new Promise((r) => setTimeout(r, 1));
    return { ...c, idleWindowMs: c.idleWindowMs + 1 };
  })));
  expect(readFlowConfig().idleWindowMs).toBe(1 + N);
});

test("a corrupt config file reads as defaults", () => {
  writeFileSync(configPath(), "{ half a file");
  expect(readFlowConfig()).toEqual(DEFAULT_FLOW_CONFIG);
});

test("a v2 file's risk tiers are dropped, and consent starts ungiven", () => {
  const cfg = parseFlowConfig({
    version: 2,
    risk: { read: "auto", insert: "auto", control: "ask", destructive: "ask" },
    toolRisk: { insert_text: "ask" },
    idleWindowMs: 90_000,
  }) as unknown as Record<string, unknown>;
  expect(cfg).not.toHaveProperty("risk");
  expect(cfg).not.toHaveProperty("toolRisk");
  expect(cfg.consent).toEqual({ granted: false, at: "" });
  expect(cfg.idleWindowMs).toBe(90_000);
});

test("consent survives a write, stamp and all", () => {
  const at = "2026-03-04T10:00:00.000Z";
  expect(parseFlowConfig({ consent: { granted: true, at } }).consent).toEqual({ granted: true, at });
});

test("Flow's own wait starts Patient, for when it is turned on, because hands-free has no send button", () => {
  const cfg = parseFlowConfig({});
  expect(cfg.voice.turn).toEqual({ threshold: 0.65, holdMs: 6000, redemptionMs: 800 });
});

test("a new Flow follows Chat: both overrides start off", () => {
  const cfg = parseFlowConfig({});
  expect(cfg.brain.override).toBe(false);
  expect(cfg.voice.turnOverride).toBe(false);
  expect(flowBrain(cfg, {})).toEqual({ kind: "api", agentId: "", agentModel: "", agentEffort: "" });
  expect(flowTurn(cfg)).toBeNull();
});

test("the frozen v6 fixture keeps its coding agent and leaves the wait for the renderer to decide", () => {
  const cfg = parseFlowConfig(CONFIG_V6_FIXTURE);
  expect(cfg.version).toBe(FLOW_CONFIG_VERSION);
  expect(cfg.brain).toEqual({ override: true, kind: "acp", agentId: "claude-code", agentModel: "haiku", agentEffort: "" });
  expect(flowBrain(cfg, {})).toEqual({ kind: "acp", agentId: "claude-code", agentModel: "haiku", agentEffort: "" });
  expect(cfg.voice.turnOverride).toBeNull();
  // Undecided counts as on, so the Flow it came from keeps waiting as it did.
  expect(flowTurn(cfg)).toEqual({ threshold: 0.65, holdMs: 6000, redemptionMs: 800 });
  expect(cfg.consent.granted).toBe(true);
});

test("a v6 API brain already was Chat's, so its override stays off", () => {
  const cfg = parseFlowConfig({ version: 6, brain: { kind: "api", agentId: "codex", agentModel: "x", agentEffort: "" } });
  expect(cfg.brain.override).toBe(false);
  expect(flowBrain(cfg, {}).kind).toBe("api");
});

test("the default is the API key until settings name a coding agent, and an unknown id stays on the API key", () => {
  expect(defaultBrain({})).toEqual({ kind: "api", agentId: "", agentModel: "", agentEffort: "" });
  expect(defaultBrain({ defaultAgent: "" })).toMatchObject({ kind: "api" });
  expect(defaultBrain({ defaultAgent: "not-an-agent" })).toMatchObject({ kind: "api" });
  expect(defaultBrain({ defaultAgent: "codex", defaultAgentModel: "gpt-5" })).toEqual({ kind: "acp", agentId: "codex", agentModel: "gpt-5", agentEffort: "" });
});

test("the default round-trips through its settings, and the API key clears the agent's", () => {
  const agent = { kind: "acp" as const, agentId: "claude-code", agentModel: "haiku", agentEffort: "low" };
  expect(defaultBrain(defaultBrainSettings(agent))).toEqual(agent);
  expect(defaultBrainSettings({ ...agent, kind: "api" })).toEqual({ defaultAgent: "", defaultAgentModel: "", defaultAgentEffort: "" });
});

test("Flow follows the default until it has its own, whichever the default is", () => {
  const codex = { defaultAgent: "codex" };
  const follows = parseFlowConfig({});
  expect(flowBrain(follows, codex)).toMatchObject({ kind: "acp", agentId: "codex" });
  // Its own API key stays the API key when the default is a coding agent.
  const ownApi = parseFlowConfig({ brain: { override: true, kind: "api" } });
  expect(flowBrain(ownApi, codex).kind).toBe("api");
  const ownAgent = parseFlowConfig({ brain: { override: true, kind: "acp", agentId: "claude-code" } });
  expect(flowBrain(ownAgent, {})).toMatchObject({ kind: "acp", agentId: "claude-code" });
});

test("a Flow that ran on the API key with a coding agent left unused in its file still does, under an unset default", () => {
  // Flow's first run once saved a coding agent without turning the override on.
  for (const raw of [{ version: 8, brain: { override: false, kind: "acp", agentId: "codex" } }, { version: 7, brain: { kind: "acp", agentId: "codex" } }]) {
    expect(flowBrain(parseFlowConfig(raw), {}).kind).toBe("api");
    expect(dictateBrain(parseFlowConfig(raw), {}).kind).toBe("api");
  }
});

test("an older file walks every migration into the current version", () => {
  const cfg = parseFlowConfig(CONFIG_V1_FIXTURE);
  expect(cfg.brain.override).toBe(false);
  expect(cfg.voice.turnOverride).toBeNull();
});

test("a decided override survives a write, and a v7 file is not migrated again", () => {
  const on = parseFlowConfig({ version: 7, brain: { override: true, kind: "acp", agentId: "codex" }, voice: { turnOverride: true } });
  expect(parseFlowConfig(on)).toEqual(on);
  const off = parseFlowConfig({ version: 7, brain: { kind: "acp", agentId: "codex" }, voice: { turnOverride: false } });
  expect(flowBrain(off, {}).kind).toBe("api");
  expect(flowTurn(off)).toBeNull();
  expect(parseFlowConfig({ version: 7, voice: { turnOverride: "yes" } }).voice.turnOverride).toBe(false);
});

test("the frozen v7 fixture moves off the old 100 ms modifier hold and keeps the rest", () => {
  const cfg = parseFlowConfig(CONFIG_V7_FIXTURE);
  expect(cfg.version).toBe(FLOW_CONFIG_VERSION);
  expect(cfg.insertion).toEqual({ method: "paste", modifierHoldMs: 50, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: true });
  expect(cfg.dictate.polish).toEqual({ enabled: true, tone: "casual" });
  expect(cfg.voice.turnOverride).toBe(false);
});

test("Flow stays on for a file from before its switch was kept, and off once turned off", () => {
  for (const old of [CONFIG_V1_FIXTURE, CONFIG_V6_FIXTURE, CONFIG_V7_FIXTURE, {}]) expect(parseFlowConfig(old).enabled).toBe(true);
  expect(parseFlowConfig({ version: FLOW_CONFIG_VERSION, enabled: false }).enabled).toBe(false);
  expect(parseFlowConfig({ enabled: "no" }).enabled).toBe(true);
});

test("a modifier hold someone chose survives the move, and a current file is not moved", () => {
  for (const ms of [0, 30, 99, 150]) expect(parseFlowConfig({ version: 7, insertion: { modifierHoldMs: ms } }).insertion.modifierHoldMs).toBe(ms);
  expect(parseFlowConfig({ version: 7 }).insertion.modifierHoldMs).toBe(50);
  expect(parseFlowConfig({ version: FLOW_CONFIG_VERSION, insertion: { modifierHoldMs: 100 } }).insertion.modifierHoldMs).toBe(100);
  // An older file still on the old default moves too.
  expect(parseFlowConfig(CONFIG_V6_FIXTURE).insertion.modifierHoldMs).toBe(50);
});

test("clamps turn-taking to what the voice pipeline will accept", () => {
  const cfg = parseFlowConfig({ voice: { turn: { threshold: 4, holdMs: 99_000, redemptionMs: 0 } } });
  expect(cfg.voice.turn).toEqual({ threshold: 1, holdMs: 8000, redemptionMs: 200 });
});

test("an older file gets Dictate off, on Right Alt, with every cleanup rule on, and its clipboard put back", () => {
  const cfg = parseFlowConfig(CONFIG_V6_FIXTURE);
  expect(cfg.insertion.restoreClipboard).toBe(true);
  expect(cfg.dictate).toEqual(DEFAULT_FLOW_CONFIG.dictate);
  expect(cfg.dictate.enabled).toBe(false);
  expect(cfg.dictate.hotkey).toBe("option_right");
});

test("Dictate's settings fall back per field, and a blank hotkey is not a hotkey", () => {
  const cfg = parseFlowConfig({
    insertion: { restoreClipboard: false },
    dictate: { enabled: true, hotkey: "  ", cleanup: { fillers: false, lists: "no" }, brain: { override: true, kind: "acp", agentId: "codex" } },
  });
  expect(cfg.insertion.restoreClipboard).toBe(false);
  expect(cfg.dictate.enabled).toBe(true);
  expect(cfg.dictate.hotkey).toBe("option_right");
  expect(cfg.dictate.cleanup).toEqual({ punctuation: true, fillers: false, backtrack: true, lists: true, numbers: true });
  expect(cfg.dictate.brain).toEqual({ override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" });
});

test("Dictate's extras keep only well-formed words and snippets, and a bad tone or keep falls back", () => {
  const cfg = parseFlowConfig({
    dictate: {
      polish: { enabled: true, tone: "shouty" },
      words: ["  OpenLive ", "", 7, "x".repeat(200)],
      snippets: [{ trigger: " my address ", text: "221B Baker Street" }, { trigger: "", text: "lost" }, { trigger: "empty", text: "" }, "junk"],
      commands: { enter: false },
      history: "decade",
    },
  });
  expect(cfg.dictate.polish).toEqual({ enabled: true, tone: "natural" });
  expect(cfg.dictate.words).toEqual(["OpenLive", "x".repeat(80)]);
  expect(cfg.dictate.snippets).toEqual([{ trigger: "my address", text: "221B Baker Street" }]);
  expect(cfg.dictate.commands).toEqual({ enter: false, newLine: true, newParagraph: true, undo: true, stop: true });
  expect(cfg.dictate.history).toBe("month");
  expect(cfg.dictate.commandHotkey).toBe("shift+option_right");
});

test("Dictate thinks with Flow's brain until it is given its own", () => {
  const flowOwn = parseFlowConfig({ brain: { override: true, kind: "acp", agentId: "codex" } });
  expect(dictateBrain(flowOwn, {})).toEqual(flowBrain(flowOwn, {}));
  const own = parseFlowConfig({ dictate: { brain: { override: true, kind: "acp", agentId: "claude-code" } } });
  expect(dictateBrain(own, {})).toEqual({ kind: "acp", agentId: "claude-code", agentModel: "", agentEffort: "" });
});
