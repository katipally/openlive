// A live turn streams each model step on its own and the session stores the turn as
// one text, so two steps' words must not run together: "On it.No workspace…".
import { expect, test, vi } from "vitest";
import type { ChatRequest, Message } from "@openlive/harness";
import type { MessageBlock, SseEvent } from "@openlive/shared";
import { foldBlock } from "../block-emit.ts";
import { LiveTurnRunner, stepGap } from "./turn-runner.ts";

// A model that calls a tool on every step it is allowed to, and calls one anyway
// when told not to, the worst a provider can do with the step cap.
const asked: ChatRequest[] = [];
vi.mock("@openlive/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openlive/harness")>()),
  streamProvider: (_p: unknown, _k: unknown, req: ChatRequest) => { asked.push(structuredClone(req)); return req; },
}));
vi.mock("../turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../turn.ts")>()),
  collectTurn: async (req: ChatRequest, emit: (e: SseEvent) => unknown) => {
    const text = req.toolChoice === "none" ? "Here is what I found." : "";
    if (text) await emit({ type: "text_delta", text });
    return { text, reasoning: "", toolCalls: [{ id: `c${asked.length}`, name: "look", arguments: "{}" }], usage: { input: 1, output: 1 } };
  },
}));
vi.mock("../providers.js", () => ({
  resolveLive: () => ({ provider: { keyless: true, protocol: "anthropic" }, model: "m", apiKey: null }),
  resolveVision: () => null,
  liveReasoning: () => ({}),
}));
vi.mock("../prompt.js", () => ({ buildLivePrompt: () => "SYSTEM" }));
vi.mock("../tool-images.js", () => ({ prepareToolImages: async (m: Message[]) => m }));
vi.mock("../tools.js", () => ({ buildOpenLiveTools: () => [{ name: "look", description: "", parameters: {}, execute: async () => ({ output: "seen" }) }] }));
vi.mock("./worker.js", () => ({ runWorker: async () => "" }));

test("keeps a space between two steps' text in the saved turn", () => {
  const blocks: MessageBlock[] = [];
  foldBlock(blocks, { type: "text_delta", text: "On it." });
  const next = "No workspace folder is set.";
  foldBlock(blocks, { type: "text_delta", text: stepGap("On it.", next) + next });
  expect(blocks).toEqual([{ type: "text", text: "On it. No workspace folder is set." }]);
});

test("adds nothing where the boundary already has whitespace or a side is empty", () => {
  expect(stepGap("On it. ", "Next")).toBe("");
  expect(stepGap("On it.", "\nNext")).toBe("");
  expect(stepGap("", "Next")).toBe("");
  expect(stepGap("On it.", "")).toBe("");
});

test("the call's prompt gains one language line outside English, and stays byte-identical in it", async () => {
  const { withLanguage } = await import("./turn-runner.ts");
  expect(withLanguage("PROMPT")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "en")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "ko")).toBe("PROMPT\n\n---\nAlways reply in Korean.");
});

test("a turn that spends its tool budget still ends in a spoken reply, with every call answered", async () => {
  const events: SseEvent[] = [];
  const runner = new LiveTurnRunner([]);
  await runner.runTurn("dig into it", [], (e) => { events.push(e); }, new AbortController().signal);
  expect(asked.map((r) => r.toolChoice)).toEqual([...Array(6).fill(undefined), "none"]);
  expect(asked.at(-1)!.tools.map((t) => t.name)).toEqual(["look"]);
  expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "Here is what I found." }]);
  const messages = (runner as unknown as { messages: Message[] }).messages;
  expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Here is what I found.", toolCalls: undefined });
  const called = messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []).map((c) => c.id));
  const answered = messages.flatMap((m) => (m.role === "tool" ? [m.callId] : []));
  expect(answered).toEqual(called);
  expect(called).toHaveLength(6);
});
