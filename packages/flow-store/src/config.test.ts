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
  expect(cfg.binding).toBe("rightalt");
  expect(cfg.activation).toBe("hold_or_toggle");
  expect(cfg.holdThresholdMs).toBe(250);
  expect(cfg.insertion.method).toBe("paste");
  expect(cfg.insertion.clipboardTimeoutMs).toBe(8000);
  expect(cfg.brain.kind).toBe("openlive");
  expect(cfg.voice.autoQuiet.micContention).toBe(true);
  expect(cfg.risk).toEqual({ read: "auto", insert: "auto", control: "ask", destructive: "ask" });
  expect(cfg.idleWindowMs).toBe(300000);
  expect(cfg.stt.whisperSize).toBe("base");
  expect(cfg.tts).toEqual({ engine: "kokoro", voice: "af_heart", speed: 1 });
});

test("nothing fails the parse", () => {
  expect(parseFlowConfig(undefined)).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig("not an object")).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig([1, 2, 3])).toEqual(DEFAULT_FLOW_CONFIG);
  expect(parseFlowConfig({})).toEqual(DEFAULT_FLOW_CONFIG);
});

test("missing and invalid keys fall back per field, not per file", () => {
  const cfg = parseFlowConfig({
    binding: "ctrl+space",
    activation: "telepathy",
    holdThresholdMs: "soon",
    insertion: { method: "type" },
    risk: { destructive: "auto", control: 7 },
    tts: { speed: 0 },
  });
  expect(cfg.binding).toBe("ctrl+space");
  expect(cfg.insertion.method).toBe("type");
  expect(cfg.insertion.modifierHoldMs).toBe(DEFAULT_FLOW_CONFIG.insertion.modifierHoldMs);
  expect(cfg.activation).toBe(DEFAULT_FLOW_CONFIG.activation);
  expect(cfg.holdThresholdMs).toBe(DEFAULT_FLOW_CONFIG.holdThresholdMs);
  expect(cfg.risk.destructive).toBe("ask"); // destructive always asks, whatever the file says
  expect(cfg.risk.control).toBe(DEFAULT_FLOW_CONFIG.risk.control);
  expect(cfg.tts.speed).toBe(DEFAULT_FLOW_CONFIG.tts.speed);
});

test("a newer build's keys survive an older build's write", async () => {
  writeFileSync(configPath(), JSON.stringify({
    version: FLOW_CONFIG_VERSION,
    binding: "fn",
    futureField: { deep: [1, 2] },
    voice: { futureVoiceKey: "keep me" },
  }));
  const loaded = readFlowConfig() as unknown as Record<string, unknown>;
  expect(loaded.futureField).toEqual({ deep: [1, 2] });

  await updateFlowConfig((c) => ({ ...c, holdThresholdMs: 400 }));
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  expect(onDisk.futureField).toEqual({ deep: [1, 2] });
  expect(onDisk.voice.futureVoiceKey).toBe("keep me");
  expect(onDisk.voice.speakReplies).toBe(true);
  expect(onDisk.holdThresholdMs).toBe(400);
  expect(onDisk.binding).toBe("fn");
});

test("updateFlowConfig holds the lock across the whole read-modify-write", async () => {
  await updateFlowConfig((c) => ({ ...c, holdThresholdMs: 0 }));
  const N = 20;
  await Promise.all(Array.from({ length: N }, () => updateFlowConfig(async (c) => {
    await new Promise((r) => setTimeout(r, 1));
    return { ...c, holdThresholdMs: c.holdThresholdMs + 1 };
  })));
  expect(readFlowConfig().holdThresholdMs).toBe(N);
});

test("a corrupt config file reads as defaults", () => {
  writeFileSync(configPath(), "{ half a file");
  expect(readFlowConfig()).toEqual(DEFAULT_FLOW_CONFIG);
});

test("per-tool overrides keep only the actions this build understands", () => {
  const cfg = parseFlowConfig({ toolRisk: { insert_text: "ask", click: "sometimes", run_command: "deny" } });
  expect(cfg.toolRisk).toEqual({ insert_text: "ask", run_command: "deny" });
  expect(parseFlowConfig({}).toolRisk).toEqual({});
});
