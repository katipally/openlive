// Guards the untrusted-config merge/clamp — the only non-trivial logic here.
import assert from "node:assert";
import { test } from "vitest";
import { mergePipelineConfig, clampPipelineConfig, workerTag, tagCached, browserModels, DEFAULT_PIPELINE_CONFIG, KOKORO_VOICES, SUPERTONIC_VOICES, STT_ENGINES, STT_ENGINE_IDS, TTS_ENGINES } from "./pipelineConfig.ts";

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

test("vad model: v6 by default and for old saved configs; v5 sticks; unknown falls back", () => {
  assert.equal(DEFAULT_PIPELINE_CONFIG.vad.model, "v6");
  assert.equal(mergePipelineConfig({ vad: { speechThreshold: 0.4, redemptionMs: 550 } }).vad.model, "v6");
  assert.equal(mergePipelineConfig({ vad: { model: "v5" } }).vad.model, "v5");
  assert.equal(mergePipelineConfig({ vad: { model: "v4" } }).vad.model, "v6");
  assert.equal(clampPipelineConfig(full({})).vad.model, "v6");
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

test("stt engine: a config saved before engines existed keeps Whisper and its size", () => {
  const old = mergePipelineConfig({ stt: { whisperSize: "small" }, tts: { engine: "kokoro", voice: "am_onyx", speed: 1 } });
  assert.deepEqual(old.stt, { engine: "whisper", whisperSize: "small" });
  assert.equal(clampPipelineConfig(full({})).stt.engine, "whisper");
});

test("stt engine: native picks stick, unknown ones fall back to Whisper", () => {
  for (const engine of ["nemotron", "parakeet", "moonshine"]) assert.equal(mergePipelineConfig({ stt: { engine } }).stt.engine, engine);
  assert.equal(mergePipelineConfig({ stt: { engine: "deepgram" } }).stt.engine, "whisper");
  assert.equal(mergePipelineConfig({ stt: { engine: 7 } }).stt.engine, "whisper");
});

test("native tts engines: voices snap to the engine's catalog, French Pocket voice is not offered", () => {
  assert.equal(mergePipelineConfig({ tts: { engine: "pocket" } }).tts.voice, "bria");
  assert.equal(mergePipelineConfig({ tts: { engine: "pocket", voice: "loona" } }).tts.voice, "loona");
  assert.equal(mergePipelineConfig({ tts: { engine: "pocket", voice: "hibiki" } }).tts.voice, "bria");
  assert.equal(mergePipelineConfig({ tts: { engine: "kitten", voice: "jasper" } }).tts.voice, "jasper");
  assert.equal(mergePipelineConfig({ tts: { engine: "kitten", voice: "af_heart" } }).tts.voice, "bella");
});

test("catalog integrity: every engine is listed once, every default voice exists", () => {
  assert.deepEqual(STT_ENGINES.map((e) => e.id), [...STT_ENGINE_IDS]);
  assert.ok(STT_ENGINES.every((e) => e.native === (e.id !== "whisper")));
  for (const e of TTS_ENGINES) if (e.id !== "clone") assert.ok(e.voices.some((v) => v.id === e.defaultVoice), e.id);
  assert.match(TTS_ENGINES.find((e) => e.id === "pocket")!.note!, /non-commercial/i);
});

test("workerTag: moving between native engines keeps the warm worker; browser weights change it", () => {
  const cfg = (stt: string, tts: string, whisperSize = "base") => mergePipelineConfig({ stt: { engine: stt, whisperSize }, tts: { engine: tts } });
  // Unchanged for the in-browser engines, so an existing cached flag still matches.
  assert.equal(workerTag(cfg("whisper", "kokoro"), "webgpu"), "webgpu:base:kokoro");
  assert.equal(workerTag(cfg("whisper", "kokoro", "small"), "wasm"), "wasm:tiny:kokoro");
  assert.equal(workerTag(cfg("parakeet", "pocket"), "webgpu"), workerTag(cfg("nemotron", "kitten"), "webgpu"));
  assert.equal(workerTag(cfg("moonshine", "kitten", "small"), "webgpu"), "webgpu:native:native");
  assert.notEqual(workerTag(cfg("parakeet", "kitten"), "webgpu"), workerTag(cfg("parakeet", "kokoro"), "webgpu"));
  assert.notEqual(workerTag(cfg("parakeet", "clone"), "webgpu"), workerTag(cfg("parakeet", "pocket"), "webgpu"));
});

test("browserModels: only what the worker downloads for the selected engines", () => {
  const cfg = (stt: string, tts: string) => mergePipelineConfig({ stt: { engine: stt }, tts: { engine: tts } });
  assert.deepEqual(browserModels(cfg("whisper", "kokoro")), ["speech", "voice", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("parakeet", "pocket")), ["turn-taking"]);
  assert.deepEqual(browserModels(cfg("nemotron", "supertonic")), ["voice", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("whisper", "kitten")), ["speech", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("moonshine", "clone")), ["voice", "turn-taking"]); // Kokoro stays as the clone's fallback
});

test("a config counts as cached when every part it downloads was loaded before, on the same tier", () => {
  // Moving to native engines needs only Smart-Turn, which every load brought.
  assert.equal(tagCached("webgpu:native:native", ["webgpu:base:kokoro"]), true);
  assert.equal(tagCached("webgpu:base:native", ["webgpu:native:native", "webgpu:base:supertonic"]), true);
  assert.equal(tagCached("webgpu:small:kokoro", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("webgpu:base:supertonic", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("wasm:native:native", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("webgpu:native:native", []), false);
});
