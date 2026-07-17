// Guards the untrusted-config merge/clamp — the only non-trivial logic here.
import assert from "node:assert";
import { test } from "vitest";
import { mergePipelineConfig, clampPipelineConfig, DEFAULT_PIPELINE_CONFIG, KOKORO_VOICES, SUPERTONIC_VOICES } from "./pipelineConfig.ts";

test("empty / garbage input → defaults", () => {
  assert.deepEqual(mergePipelineConfig({}), DEFAULT_PIPELINE_CONFIG);
  assert.deepEqual(mergePipelineConfig(null), DEFAULT_PIPELINE_CONFIG);
  assert.deepEqual(mergePipelineConfig("nonsense"), DEFAULT_PIPELINE_CONFIG);
});

test("partial input keeps given fields, fills the rest from defaults", () => {
  const m = mergePipelineConfig({ tts: { voice: "am_onyx" }, stt: { whisperSize: "small" } });
  assert.equal(m.tts.voice, "am_onyx");
  assert.equal(m.tts.speed, DEFAULT_PIPELINE_CONFIG.tts.speed);
  assert.equal(m.stt.whisperSize, "small");
  assert.equal(m.turn.engine, "smart-turn");
});

test("unknown enum/voice values fall back to defaults", () => {
  assert.equal(mergePipelineConfig({ tts: { voice: "zz_bogus" } }).tts.voice, "af_heart");
  assert.equal(mergePipelineConfig({ stt: { whisperSize: "gigantic" } }).stt.whisperSize, "base");
  assert.equal(mergePipelineConfig({ turn: { engine: "telepathy" } }).turn.engine, "smart-turn");
});

const full = (over: object) => ({ stt: { whisperSize: "base" }, tts: { voice: "af_heart", speed: 1 }, turn: { engine: "smart-turn", threshold: 0.5, holdMs: 4000 }, vad: { speechThreshold: 0.5, redemptionMs: 550 }, ...over });

test("out-of-range numbers clamp", () => {
  assert.equal(clampPipelineConfig(full({ tts: { voice: "af_heart", speed: 99 } })).tts.speed, 2);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: -5, holdMs: 4000 } })).turn.threshold, 0);
  assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 5, redemptionMs: 550 } })).vad.speechThreshold, 0.9);
  assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 0.5, redemptionMs: 99999 } })).vad.redemptionMs, 1500);
});

test("mid-thought hold clamps to 1–8 s; missing/garbage falls back to the default", () => {
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5, holdMs: 100 } })).turn.holdMs, 1000);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5, holdMs: 60000 } })).turn.holdMs, 8000);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5 } })).turn.holdMs, 4000);
  assert.equal(mergePipelineConfig({ turn: { holdMs: 2500 } }).turn.holdMs, 2500);
  assert.equal(mergePipelineConfig({}).turn.holdMs, 4000);
});

test("catalog integrity: 28 English voices, all with a valid accent/gender", () => {
  assert.equal(KOKORO_VOICES.length, 28);
  assert.ok(KOKORO_VOICES.every((v) => (v.accent === "American" || v.accent === "British") && (v.gender === "Female" || v.gender === "Male")));
});

test("tts engine: unknown engine falls back; voice snaps to the engine's catalog", () => {
  assert.equal(mergePipelineConfig({ tts: { engine: "bark" } }).tts.engine, "kokoro");
  // Switching to supertonic with a kokoro voice → that engine's default voice.
  const st = mergePipelineConfig({ tts: { engine: "supertonic", voice: "af_heart" } });
  assert.equal(st.tts.engine, "supertonic");
  assert.equal(st.tts.voice, "M1");
  // A valid supertonic voice sticks.
  assert.equal(mergePipelineConfig({ tts: { engine: "supertonic", voice: "F3" } }).tts.voice, "F3");
  // And the reverse: kokoro engine rejects a supertonic voice id.
  assert.equal(mergePipelineConfig({ tts: { engine: "kokoro", voice: "F3" } }).tts.voice, "af_heart");
  assert.equal(SUPERTONIC_VOICES.length, 10);
});
