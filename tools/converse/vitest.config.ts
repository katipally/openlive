import { defineConfig } from "vitest/config";

// The eval runs the app's own VoiceEngine under vitest, for its module mocks
// (run.eval.ts says which parts are real). Not in the root suite: it needs a
// running agent and spends model tokens.
export default defineConfig({
  test: { include: ["src/run.eval.ts"], environment: "node", testTimeout: 60 * 60_000, hookTimeout: 5 * 60_000 },
});
