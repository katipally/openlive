import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CONFIG_V1_FIXTURE } from "./config.v1.fixture";
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
  expect(cfg.stt.whisperSize).toBe("base");
  expect(cfg.tts).toEqual({ engine: "kokoro", voice: "af_heart", speed: 1 });
  // v2 has one gesture and v3 has one permission, so the fields that used to
  // configure the trigger and the risk tiers are dropped on the way through
  // rather than left behind as dead settings.
  for (const gone of ["binding", "activation", "holdThresholdMs", "risk", "toolRisk"]) {
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
  expect(brain).toEqual({ kind: "api", agentId: "codex", agentModel: "x", agentEffort: "low" });
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
    tts: { speed: 0 },
  });
  expect(cfg.insertion.method).toBe("type");
  expect(cfg.insertion.modifierHoldMs).toBe(DEFAULT_FLOW_CONFIG.insertion.modifierHoldMs);
  expect(cfg.idleWindowMs).toBe(DEFAULT_FLOW_CONFIG.idleWindowMs);
  expect(cfg.consent).toEqual(DEFAULT_FLOW_CONFIG.consent);
  expect(cfg.tts.speed).toBe(DEFAULT_FLOW_CONFIG.tts.speed);
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

test("waits for the rest of a sentence by default, because hands-free has no send button", () => {
  const cfg = parseFlowConfig({});
  expect(cfg.voice.turn).toEqual({ threshold: 0.65, holdMs: 6000, redemptionMs: 800 });
});

test("clamps turn-taking to what the voice pipeline will accept", () => {
  const cfg = parseFlowConfig({ voice: { turn: { threshold: 4, holdMs: 99_000, redemptionMs: 0 } } });
  expect(cfg.voice.turn).toEqual({ threshold: 1, holdMs: 8000, redemptionMs: 200 });
});
