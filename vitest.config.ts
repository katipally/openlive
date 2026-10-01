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
    env: { OPENLIVE_CU_HELPER: "" },
  },
});
