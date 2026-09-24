// A slow lookup's spoken cue must fill the wait, not land inside the answer.
import { expect, test, vi } from "vitest";
import type { SseEvent } from "@openlive/shared";

vi.mock("../providers.js", () => ({ resolveLive: () => ({ provider: { keyless: true, protocol: "anthropic" }, model: "m", apiKey: null }) }));
let step = 0;
vi.mock("../turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../turn.ts")>()),
  collectTurn: async () => (step++ === 0
    ? { text: "", toolCalls: [{ id: "c1", name: "web_search", arguments: JSON.stringify({ query: "paris weather today" }) }] }
    : { text: "Sunny.", toolCalls: [] }),
}));
vi.mock("../tools.js", () => ({
  buildWorkerTools: () => [{ name: "web_search", execute: () => new Promise((r) => setTimeout(() => r({ output: "sunny" }), 2000)) }],
}));
const { runWorker } = await import("./worker.ts");

test("a slow lookup is narrated out of band, never as reply text", async () => {
  vi.useFakeTimers();
  const events: SseEvent[] = [];
  const done = runWorker("weather in paris", async (e) => { events.push(e); }, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await done).toBe("Sunny.");
  expect(events).toEqual([{ type: "say", text: "Still searching for paris weather today." }]);
  vi.useRealTimers();
});
