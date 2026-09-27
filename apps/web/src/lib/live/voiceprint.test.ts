import { afterEach, expect, it, vi } from "vitest";
import { verifyVoice } from "./voiceprint";

const verdict = { you: false, score: 0.1, embedding: [1] };
/** Blocks the thread, as a busy page does. */
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms); };
/** Like the browser: the request leaves once the calling task ends, and the agent answers `answerMs` later (never: stuck). */
function agent(answerMs: number | null) {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    if (answerMs !== null) setTimeout(() => setTimeout(() => resolve(new Response(JSON.stringify(verdict))), answerMs), 0);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

it("waits for a verdict sent late by a busy page", async () => {
  agent(50);
  const v = verifyVoice(new Float32Array(16), "mic", 900);
  busy(1600); // past the timeout before the request has even left
  expect(await v).toEqual(verdict);
});

it("lets speech through when the agent is stuck", async () => {
  agent(null);
  expect(await verifyVoice(new Float32Array(16), "mic", 900)).toBeNull();
});
