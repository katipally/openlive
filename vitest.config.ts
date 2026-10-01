import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// One root runner for every package's colocated *.test.ts files (they existed
// before this config but had no framework to run them).
export default defineConfig({
  test: {
    // The desktop shell is plain CJS with no src/, so its tests sit beside it.
    include: ["{apps,services,packages,tools}/*/src/**/*.test.ts", "apps/desktop/*.test.ts", "apps/desktop/telemetry/*.test.ts", "native/*/scripts/*.test.ts"],
    environment: "node",
    // No computer-use helper unless a test brings its own: a dev build on the
    // machine running the tests must not change which tools a session gets.
    // And a throwaway OpenLive home unless a test names its own: without one, a
    // dev checkout's tests would read and reshape the real <repo>/data.
    env: { OPENLIVE_CU_HELPER: "", OPENLIVE_HOME: mkdtempSync(join(tmpdir(), "openlive-test-home-")) },
  },
});
