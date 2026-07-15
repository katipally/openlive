// Runnable self-check (no framework): `node src/lib/live/pipelineConfig.test.ts`.
// Guards the untrusted-config merge/clamp — the only non-trivial logic here.
import assert from "node:assert";
import { mergePipelineConfig, clampPipelineConfig, DEFAULT_PIPELINE_CONFIG, KOKORO_VOICES } from "./pipelineConfig.ts";

// Empty / garbage input → defaults.
assert.deepEqual(mergePipelineConfig({}), DEFAULT_PIPELINE_CONFIG);
assert.deepEqual(mergePipelineConfig(null), DEFAULT_PIPELINE_CONFIG);
assert.deepEqual(mergePipelineConfig("nonsense"), DEFAULT_PIPELINE_CONFIG);

// Partial input keeps given fields, fills the rest from defaults.
const m = mergePipelineConfig({ tts: { voice: "am_onyx" }, stt: { whisperSize: "small" } });
assert.equal(m.tts.voice, "am_onyx");
assert.equal(m.tts.speed, DEFAULT_PIPELINE_CONFIG.tts.speed);
assert.equal(m.stt.whisperSize, "small");
assert.equal(m.turn.engine, "smart-turn");

// Unknown enum/voice values fall back to defaults.
assert.equal(mergePipelineConfig({ tts: { voice: "zz_bogus" } }).tts.voice, "af_heart");
assert.equal(mergePipelineConfig({ stt: { whisperSize: "gigantic" } }).stt.whisperSize, "base");
assert.equal(mergePipelineConfig({ turn: { engine: "telepathy" } }).turn.engine, "smart-turn");

// Out-of-range numbers clamp (full configs → clampPipelineConfig).
const full = (over) => ({ stt: { whisperSize: "base" }, tts: { voice: "af_heart", speed: 1 }, turn: { engine: "smart-turn", threshold: 0.5 }, vad: { speechThreshold: 0.5, redemptionMs: 550 }, ...over });
assert.equal(clampPipelineConfig(full({ tts: { voice: "af_heart", speed: 99 } })).tts.speed, 2);
assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: -5 } })).turn.threshold, 0);
assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 5, redemptionMs: 550 } })).vad.speechThreshold, 0.9);
assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 0.5, redemptionMs: 99999 } })).vad.redemptionMs, 1500);

// Catalog integrity: 28 English voices, all with a valid accent/gender.
assert.equal(KOKORO_VOICES.length, 28);
assert.ok(KOKORO_VOICES.every((v) => (v.accent === "American" || v.accent === "British") && (v.gender === "Female" || v.gender === "Male")));

console.log("pipelineConfig.test.ts: all assertions passed");
