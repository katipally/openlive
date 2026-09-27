import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each embed() answers with the next vector queued here.
const queue = vi.hoisted(() => ({ next: [] as number[][] }));
vi.mock("./native.js", () => ({ embed: async () => Float32Array.from(queue.next.shift()!) }));

// DATA_DIR is resolved when @openlive/db loads, so point it at a temp dir first.
let dir: string;
let vp: typeof import("./voiceprint.js");
const SECOND = new Float32Array(16000);
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-voiceprint-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  vi.resetModules();
  vp = await import("./voiceprint.js");
  const model = join(dir, "models", vp.SPEAKER_MODEL.id);
  mkdirSync(model, { recursive: true });
  for (const f of vp.SPEAKER_MODEL.files) writeFileSync(join(model, f), "x");
});
afterAll(() => { delete process.env.OPENLIVE_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await vp.forgetVoiceprint(); });

const enrollOn = async (mic: string, seconds: number, e = [1, 0, 0]) => {
  queue.next.push(e);
  return vp.enroll(new Float32Array(16000 * seconds), mic, false);
};

it("is enrolled only once enough of the user's speech is in", async () => {
  expect(vp.voiceprintStatus()).toMatchObject({ installed: true, enrolled: false, prints: [] });
  await enrollOn("Built-in", 6);
  expect(vp.voiceprintStatus().enrolled).toBe(false);
  expect((await enrollOn("Built-in", 6)).enrolled).toBe(true);
});

it("lets the user through and no one else, at the threshold for the length heard", async () => {
  await enrollOn("Built-in", 15);
  const [, t1] = vp.THRESHOLDS.find(([at]) => at === 1)!, [, t2] = vp.THRESHOLDS.find(([at]) => at === 2)!;
  const at = (score: number) => [score, Math.sqrt(1 - score * score), 0]; // cosine `score` to the print
  queue.next.push([0.9, 0.3, 0], [0, 1, 0], at((t1 + t2) / 2), at((t1 + t2) / 2));
  expect(await vp.verify(SECOND, "Built-in", 1)).toMatchObject({ you: true });
  expect(await vp.verify(SECOND, "Built-in", 1)).toMatchObject({ you: false });
  // Between the two: enough for one second of speech, not for two.
  expect(await vp.verify(SECOND, "Built-in", 1.5)).toMatchObject({ you: true });
  expect(await vp.verify(SECOND, "Built-in", 2.5)).toMatchObject({ you: false });
});

it("gives a new mic a print of its own from turns that are surely the user, and never from short or unsure ones", async () => {
  await enrollOn("Built-in", 15);
  queue.next.push([1, 0.05, 0], [0.99, 0.1, 0], [0.5, 0.5, 0.7]);
  await vp.verify(SECOND, "Headset", 1); // too short to learn from
  await vp.verify(SECOND, "Headset", 3);
  await vp.verify(SECOND, "Headset", 3); // not sure enough
  expect(vp.voiceprintStatus().prints).toEqual([
    { mic: "Built-in", seconds: 15, at: expect.any(Number) },
    { mic: "Headset", seconds: 3, at: expect.any(Number) },
  ]);
});

it("gives no verdict, and learns nothing, from an embedding that says nothing about the voice", async () => {
  await enrollOn("Built-in", 15);
  queue.next.push([0, 0, 0], [NaN, 1, 0], [0, 0, 0]);
  // A score of 0 would pass the under-a-second threshold.
  expect(await vp.verify(SECOND, "Built-in", 0.9)).toBeNull();
  expect(await vp.verify(SECOND, "Built-in", 3)).toBeNull();
  expect(await vp.enroll(SECOND, "Headset", false)).toBeNull();
  expect(vp.voiceprintStatus().prints).toMatchObject([{ mic: "Built-in", seconds: 15 }]);
});

it("enrolling again on a mic starts its print over; deleting drops every print", async () => {
  await enrollOn("Built-in", 15);
  queue.next.push([0, 1, 0]);
  await vp.enroll(new Float32Array(16000 * 4), "Built-in", true);
  expect(vp.voiceprintStatus().prints).toMatchObject([{ mic: "Built-in", seconds: 4 }]);
  await vp.forgetVoiceprint();
  expect(vp.voiceprintStatus()).toMatchObject({ enrolled: false, prints: [] });
});
