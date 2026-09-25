// The web app keeps a copy of the native engine list (apps/web/src/lib/live/
// pipelineConfig.ts), cut to its curated languages, so a saved config validates
// with the agent offline. This keeps the copy and the source in step.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { LANGUAGE_CODES } from "@openlive/shared";

// DATA_DIR is resolved when @openlive/db loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), "ol-webcat-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { NATIVE_FAMILIES } = await import("./native-models.ts");
const { STT_FAMILIES, TTS_FAMILIES } = await import("../../../../apps/web/src/lib/live/pipelineConfig.ts");
afterAll(() => { delete process.env.OPENLIVE_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

const curated = new Set<string>(LANGUAGE_CODES);
const shape = (f: { id: string; variants: { id: string; languages: readonly string[]; streaming?: boolean; legacy?: string; legacyId?: string }[] }) => ({
  id: f.id,
  variants: f.variants.map((v) => ({
    id: v.id, languages: v.languages.filter((l) => curated.has(l)).sort(), streaming: !!v.streaming, legacy: v.legacy ?? v.legacyId,
  })),
});

test("the web's native engine families match the agent's, variant for variant", () => {
  const web = [...STT_FAMILIES, ...TTS_FAMILIES].filter((f) => f.native).map(shape);
  expect(web).toEqual(NATIVE_FAMILIES.map(shape));
  for (const f of NATIVE_FAMILIES) {
    const webFamily = [...STT_FAMILIES, ...TTS_FAMILIES].find((x) => x.id === f.id)!;
    expect(webFamily.stage).toBe(f.kind === "asr" ? "stt" : "tts");
  }
});
