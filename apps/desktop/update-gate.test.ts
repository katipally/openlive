import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { updatesOffReason } = createRequire(import.meta.url)("./update-gate.cjs");

describe("updatesOffReason", () => {
  it("lets a marked release build update", () => {
    expect(updatesOffReason({ env: {}, releaseBuild: true })).toBeNull();
    expect(updatesOffReason({ env: { OPENLIVE_NO_UPDATES: "0" }, releaseBuild: true })).toBeNull();
  });

  it("keeps a build the release workflow did not mark off", () => {
    expect(updatesOffReason({ env: {}, releaseBuild: false })).toMatch(/local build/);
  });

  it("is turned off by OPENLIVE_NO_UPDATES=1, even in a release build", () => {
    expect(updatesOffReason({ env: { OPENLIVE_NO_UPDATES: "1" }, releaseBuild: true })).toMatch(/OPENLIVE_NO_UPDATES/);
  });
});
