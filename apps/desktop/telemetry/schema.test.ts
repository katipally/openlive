import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BUILTIN_PROVIDERS } from "../../../packages/harness/src/registry";
import { telemetrySchema } from "../../../packages/shared/src/telemetry-schema";

const generated = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));

describe("schema.json", () => {
  it("matches packages/shared/src/telemetry-schema.ts (regenerate: node apps/desktop/scripts/gen-telemetry-schema.cjs)", () => {
    expect(generated).toEqual(JSON.parse(JSON.stringify(telemetrySchema)));
  });

  it("lists every built-in provider, so a new one cannot ship without being reportable", () => {
    expect([...telemetrySchema.subjects.provider].sort()).toEqual(BUILTIN_PROVIDERS.map((p) => p.id).sort());
  });
});
