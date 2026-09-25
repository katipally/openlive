import { expect, it, vi } from "vitest";

vi.mock("@ricky0123/vad-web", () => ({ MicVAD: class {} }));
vi.mock("./models", () => ({ resetNativeFallbacks() {} }));
vi.mock("./asrStream", () => ({ AsrStream: class {} }));
vi.mock("@/lib/log", () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }));
const { VoiceEngine } = await import("./voiceEngine");

// Between two words, or in a pause a voice keeps inside a line, the output is
// silent while the line is still playing.
it("stays on speaking through a silent stretch of a line still playing", async () => {
  const phases: string[] = [];
  const player = { level: () => 0, playing: () => true, flush() {}, close() {} };
  const eng = new VoiceEngine({ onPhase: (p) => phases.push(p) } as never, player as never);
  Object.assign(eng, { phase: "speaking" });
  (eng as any).waitDrainThenIdle((eng as any).epoch);
  await new Promise((r) => setTimeout(r, 150));
  expect(eng.currentPhase()).toBe("speaking");
  player.playing = () => false;
  await new Promise((r) => setTimeout(r, 150));
  expect(phases).toEqual(["idle"]);
});
