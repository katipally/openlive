import { defineConfig } from "vitest/config";

// One root runner for every package's colocated *.test.ts files (they existed
// before this config but had no framework to run them).
export default defineConfig({
  test: {
    include: ["{apps,services,packages}/*/src/**/*.test.ts"],
    environment: "node",
  },
});
