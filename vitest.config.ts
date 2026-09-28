import { defineConfig } from "vitest/config";

// One root runner for every package's colocated *.test.ts files (they existed
// before this config but had no framework to run them).
export default defineConfig({
  test: {
    // The desktop shell is plain CJS with no src/, so its tests sit beside it.
    include: ["{apps,services,packages,tools}/*/src/**/*.test.ts", "apps/desktop/*.test.ts", "native/*/scripts/*.test.ts"],
    environment: "node",
  },
});
