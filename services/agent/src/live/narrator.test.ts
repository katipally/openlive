// The narrator voices a clean status line into silent tool runs (out-of-band `say`,
// never a raw tool title). The commentary gate keeps speech to the opening line + the
// final answer. If the throttle/gating breaks, it talks over the agent or goes silent;
// if the gate breaks, mid-work commentary leaks into speech.
import { expect, test, vi } from "vitest";
import type { SseEvent } from "@openlive/shared";
import { wrapEmitWithNarration, createCommentaryGate } from "./narrator.ts";

function harness() {
  const out: SseEvent[] = [];
  const ac = new AbortController();
  const emit = wrapEmitWithNarration(async (e) => { out.push(e); }, ac.signal);
  // Status lines ride the out-of-band `say` channel now — never text_delta.
  const narrated = () => out.filter((e) => e.type === "say");
  return { out, ac, emit, narrated };
}

test("narrates a silent slow tool once, using the plan when present", async () => {
  vi.useFakeTimers();
  const { emit, narrated } = harness();
  await emit({ type: "todos", items: [{ text: "Read the config", done: true }, { text: "Fix the parser", done: false }] });
  await emit({ type: "tool_start", id: "1", tool: "Edit · /repo/src/parser.ts" });
  await vi.advanceTimersByTimeAsync(1600);
  expect(narrated()).toHaveLength(1);
  expect((narrated()[0] as { text: string }).text).toBe("Step 2 of 2 — Fix the parser.");
  vi.useRealTimers();
});

test("status line is a clean per-kind phrase — NEVER the raw tool title", async () => {
  vi.useFakeTimers();
  const out: SseEvent[] = [];
  const ac = new AbortController();
  const emit = wrapEmitWithNarration(async (e) => { out.push(e); }, ac.signal);
  // A raw Codex-style command title must never be spoken.
  await emit({ type: "acp_tool_call", call: { id: "1", kind: "execute", title: "sed -n '1,80p' build | head -80", status: "in_progress", locations: [], content: [] } as never });
  await vi.advanceTimersByTimeAsync(1600);
  const said = out.filter((e) => e.type === "say").map((e) => (e as { text: string }).text);
  expect(said).toEqual(["Running a command."]);
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

test("narration is ON by default: only an explicit \"0\" disables it", async () => {
  const { narrationEnabled } = await import("./narrator.ts");
  expect(narrationEnabled(undefined)).toBe(true); // never touched
  expect(narrationEnabled("")).toBe(true);        // legacy "off" empty-string default → now on
  expect(narrationEnabled("1")).toBe(true);       // explicitly on
  expect(narrationEnabled("0")).toBe(false);      // explicitly off
});

// ── commentary gate ──────────────────────────────────────────────────────────
function gateHarness() {
  const out: SseEvent[] = [];
  const ac = new AbortController();
  const gate = createCommentaryGate(async (e) => { out.push(e); }, ac.signal);
  const of = (t: string) => out.filter((e) => e.type === t).map((e) => (e as { text: string }).text);
  return { out, ac, gate, of };
}

test("gate: opening line + final answer spoken; mid-work commentary → reasoning", async () => {
  const { gate, of } = gateHarness();
  await gate.emit({ type: "text_delta", text: "Let me take a look." });     // opening — spoken live
  await gate.emit({ type: "tool_start", id: "1", tool: "read" });
  await gate.emit({ type: "text_delta", text: "Checking the parser now." }); // commentary — not spoken
  await gate.emit({ type: "acp_tool_call", call: { id: "2", kind: "read", title: "cat x", status: "in_progress", locations: [], content: [] } as never });
  await gate.emit({ type: "text_delta", text: "Here's the summary." });      // final — buffered
  await gate.flush();
  expect(of("text_delta")).toEqual(["Let me take a look.", "Here's the summary."]);
  expect(of("reasoning_delta")).toEqual(["Checking the parser now."]);
});

test("gate: pure chat (no tools) is spoken as it streams", async () => {
  const { gate, of } = gateHarness();
  await gate.emit({ type: "text_delta", text: "Hey — " });
  await gate.emit({ type: "text_delta", text: "all good." });
  await gate.flush();
  expect(of("text_delta")).toEqual(["Hey — ", "all good."]);
  expect(of("reasoning_delta")).toEqual([]);
});

test("gate: abort drops the buffered final answer (barge-in safety)", async () => {
  const { gate, ac, of } = gateHarness();
  await gate.emit({ type: "tool_start", id: "1", tool: "read" });
  await gate.emit({ type: "text_delta", text: "partial answer the user cut off" });
  ac.abort();
  await gate.flush();
  expect(of("text_delta")).toEqual([]);
});
