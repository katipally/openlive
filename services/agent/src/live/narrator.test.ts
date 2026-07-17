// The narrator injects spoken one-liners into silent tool runs. If the throttle
// breaks it talks over the agent; if the gating breaks it stays silent forever.
import { expect, test, vi } from "vitest";
import type { SseEvent } from "@openlive/shared";
import { wrapEmitWithNarration } from "./narrator.ts";

function harness() {
  const out: SseEvent[] = [];
  const ac = new AbortController();
  const emit = wrapEmitWithNarration(async (e) => { out.push(e); }, ac.signal);
  const narrated = () => out.filter((e) => e.type === "text_delta" && / now\.$|^ Step /.test((e as { text: string }).text));
  return { out, ac, emit, narrated };
}

test("narrates a silent slow tool once, using the plan when present", async () => {
  vi.useFakeTimers();
  const { emit, narrated } = harness();
  await emit({ type: "todos", items: [{ text: "Read the config", done: true }, { text: "Fix the parser", done: false }] });
  await emit({ type: "tool_start", id: "1", tool: "Edit · /repo/src/parser.ts" });
  await vi.advanceTimersByTimeAsync(1600);
  expect(narrated()).toHaveLength(1);
  expect((narrated()[0] as { text: string }).text).toBe(" Step 2 of 2 — Fix the parser.");
  vi.useRealTimers();
});

test("agent text since tool start suppresses narration; abort kills it", async () => {
  vi.useFakeTimers();
  const a = harness();
  await a.emit({ type: "tool_start", id: "1", tool: "Read" });
  await a.emit({ type: "text_delta", text: "Let me check that file." });
  await vi.advanceTimersByTimeAsync(2000);
  expect(a.narrated()).toHaveLength(0);

  const b = harness();
  await b.emit({ type: "tool_start", id: "1", tool: "Read" });
  b.ac.abort();
  await vi.advanceTimersByTimeAsync(2000);
  expect(b.narrated()).toHaveLength(0);
  vi.useRealTimers();
});

test("throttle: min gap and max lines per turn hold", async () => {
  vi.useFakeTimers();
  const { emit, narrated } = harness();
  // 10 back-to-back slow tools — only the first fires inside the 8s gap window.
  for (let i = 0; i < 2; i++) {
    await emit({ type: "tool_start", id: String(i), tool: `Tool${i}` });
    await vi.advanceTimersByTimeAsync(1600);
  }
  expect(narrated()).toHaveLength(1);
  // After the gap passes, the next slow tool narrates again — up to 4 total.
  for (let i = 2; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(8000);
    await emit({ type: "tool_start", id: String(i), tool: `Tool${i}` });
    await vi.advanceTimersByTimeAsync(1600);
  }
  expect(narrated().length).toBe(4);
  vi.useRealTimers();
});
