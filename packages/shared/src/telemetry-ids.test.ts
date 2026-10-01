// The schema's closed id lists mirror registries other packages own. An id
// missing here is dropped by the validator without a sound, so a new provider
// or engine fails this test first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { telemetrySchema as schema } from "./index";
import { BUILTIN_PROVIDERS } from "../../harness/src/registry";

// native-models resolves its data dir when it loads, so it gets an empty one.
const dir = mkdtempSync(join(tmpdir(), "ol-telemetry-ids-"));
process.env.OPENLIVE_HOME = dir;
const { NATIVE_FAMILIES } = await import("../../../services/agent/src/voice/native-models");
delete process.env.OPENLIVE_HOME;
// Not a literal path: pipelineConfig reads `window`, which this package's tsc (no DOM lib) would reject.
const pipelineConfig = "../../../apps/web/src/lib/live/pipelineConfig";
const { STT_FAMILIES, TTS_FAMILIES } = (await import(/* @vite-ignore */ pipelineConfig)) as Record<"STT_FAMILIES" | "TTS_FAMILIES", { id: string }[]>;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sameIds = (schemaIds: readonly string[], sourceIds: readonly string[]) => expect([...schemaIds].sort()).toEqual([...sourceIds].sort());
const { voice_models_result, voice_engine_fault, voice_bench_result } = schema.events;

it("names every built-in provider", () => {
  sameIds(schema.subjects.provider, BUILTIN_PROVIDERS.map((p) => p.id));
});

it("names every speech recognition and speech synthesis family the pipeline offers", () => {
  sameIds(voice_models_result.props.stt_family.values, STT_FAMILIES.map((f) => f.id));
  sameIds(voice_models_result.props.tts_family.values, TTS_FAMILIES.map((f) => f.id));
});

it("names every native engine family and kind", () => {
  sameIds(voice_engine_fault.props.engine_family.values, NATIVE_FAMILIES.map((f) => f.id));
  sameIds(voice_bench_result.props.engine_family.values, NATIVE_FAMILIES.map((f) => f.id));
  sameIds(voice_bench_result.props.engine_kind.values, [...new Set(NATIVE_FAMILIES.map((f) => f.kind))]);
});
