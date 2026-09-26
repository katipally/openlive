// The web app keeps a copy of the native engine list (apps/web/src/lib/live/
// pipelineConfig.ts), cut to its curated languages, so a saved config validates
// with the agent offline. This keeps the copy and the source in step, and the
// browser engines the agent also runs (native-models.ts `browser`) with the
// ones the web asks it for (pipelineConfig.ts `onAgent`).
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
const { licenseTag } = await import("../../../../apps/web/src/lib/live/engineMenu.ts");
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
  const own = NATIVE_FAMILIES.filter((f) => !f.browser);
  expect(web).toEqual(own.map(shape));
  for (const f of own) {
    const webFamily = [...STT_FAMILIES, ...TTS_FAMILIES].find((x) => x.id === f.id)!;
    expect(webFamily.stage).toBe(f.kind === "asr" ? "stt" : "tts");
  }
});

test("the browser engines the agent can run are the ones the web offers to run there", () => {
  expect(TTS_FAMILIES.filter((f) => f.onAgent).map((f) => f.id)).toEqual(NATIVE_FAMILIES.filter((f) => f.browser).map((f) => f.browser));
});

test("the web locks exactly the variants whose license here is not open", () => {
  const web = new Map([...STT_FAMILIES, ...TTS_FAMILIES].flatMap((f) => f.variants.map((v) => [v.id, !!v.restricted] as const)));
  for (const f of NATIVE_FAMILIES) {
    for (const v of f.variants) expect([v.id, web.get(f.browser ?? v.id)]).toEqual([v.id, licenseTag(v.license).kind !== "open"]);
  }
});
