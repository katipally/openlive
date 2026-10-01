// A live turn streams each model step on its own and the session stores the turn as
// one text, so two steps' words must not run together: "On it.No workspace…".
import { expect, test, vi } from "vitest";
import type { ChatRequest, Message } from "@openlive/harness";
import type { MessageBlock, SseEvent } from "@openlive/shared";
import { foldBlock } from "../block-emit.ts";
import { ToolSet } from "../capabilities/dispatch.ts";
import { allowAll } from "../capabilities/approval.ts";
import { LiveTurnRunner, OUT_OF_STEPS, stepGap } from "./turn-runner.ts";

// A model that calls a tool on every step it is allowed to, and calls one anyway
// when told not to, the worst a provider can do with the step cap.
const asked: ChatRequest[] = [];
// How the last, tool-free step goes: words, none, or an error over tool_choice "none".
let final: "speak" | "silent" | "reject" = "speak";
let protocol = "anthropic";
vi.mock("@openlive/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openlive/harness")>()),
  streamProvider: (_p: unknown, _k: unknown, req: ChatRequest) => { asked.push(structuredClone(req)); return req; },
}));
vi.mock("../turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../turn.ts")>()),
  collectTurn: async (req: ChatRequest, emit: (e: SseEvent) => unknown) => {
    if (req.toolChoice === "none" && final === "reject") throw new Error("400 tool_choice none is not supported");
    const text = (req.toolChoice === "none" && final === "speak") || !req.tools.length ? "Here is what I found." : "";
    if (text) await emit({ type: "text_delta", text });
    return { text, reasoning: "", toolCalls: [{ id: `c${asked.length}`, name: "look", arguments: "{}" }], usage: { input: 1, output: 1 } };
  },
}));
vi.mock("../providers.js", () => ({
  resolveLive: () => ({ provider: { keyless: true, protocol }, model: "m", apiKey: null }),
  resolveVision: () => null,
  liveReasoning: () => ({}),
}));
vi.mock("../prompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../prompt.ts")>()), buildLivePrompt: () => "SYSTEM" }));
vi.mock("../tool-images.js", () => ({ prepareToolImages: async (m: Message[]) => m }));
const look = new ToolSet([{ name: "look", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "seen" }], details: null }) }]);

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
  const { withLanguage } = await import("../prompt.ts");
  expect(withLanguage("PROMPT")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "en")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "ko")).toBe("PROMPT\n\n---\nAlways reply in Korean.");
});

test("a turn that spends its tool budget still ends in a spoken reply, with every call answered", async () => {
  const events: SseEvent[] = [];
  const runner = new LiveTurnRunner(look, {}, { approve: allowAll });
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

const spentTurn = async (how: typeof final, via = "anthropic") => {
  asked.length = 0;
  final = how;
  protocol = via;
  const events: SseEvent[] = [];
  const runner = new LiveTurnRunner(look, {}, { approve: allowAll });
  try { await runner.runTurn("dig into it", [], (e) => { events.push(e); }, new AbortController().signal); }
  finally { final = "speak"; protocol = "anthropic"; }
  const spoken = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
  return { spoken, errors: events.filter((e) => e.type === "error"), last: (runner as unknown as { messages: Message[] }).messages.at(-1)! };
};

test("a last step that still says nothing ends in a short spoken line", async () => {
  const { spoken, last } = await spentTurn("silent");
  expect(spoken).toEqual([OUT_OF_STEPS]);
  expect(last).toMatchObject({ role: "assistant", text: OUT_OF_STEPS, toolCalls: undefined });
});

test("a provider that refuses tool_choice none is asked once more without tools, where that is valid", async () => {
  const { spoken, errors, last } = await spentTurn("reject", "openai-chat");
  expect(asked.map((r) => [r.toolChoice, r.tools.length])).toEqual([...Array(6).fill([undefined, 1]), ["none", 1], [undefined, 0]]);
  expect(spoken).toEqual(["Here is what I found."]);
  expect(errors).toEqual([]);
  expect(last).toMatchObject({ role: "assistant", text: "Here is what I found." });
});

test("over Anthropic, with tool calls in the history, a refusal is not retried without tools, and the line is spoken", async () => {
  const { spoken, errors } = await spentTurn("reject");
  expect(asked).toHaveLength(7);
  expect(spoken).toEqual([OUT_OF_STEPS]);
  expect(errors).toEqual([]);
});

test("sends only the newest three tool pictures, however many steps took one", async () => {
  asked.length = 0;
  final = "speak";
  const shooting = new ToolSet([{ name: "look", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "seen" }, { type: "image", data: "PNG", mime: "image/png" }], details: null }) }]);
  const runner = new LiveTurnRunner(shooting, {}, { approve: allowAll });
  await runner.runTurn("click through it", [], () => {}, new AbortController().signal);
  const pictures = (r: ChatRequest) => r.messages.filter((m) => m.role === "tool" && m.images?.length).length;
  expect(asked.map(pictures)).toEqual([0, 1, 2, 3, 3, 3, 3]);
  expect(asked.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { result: string }).result)).toEqual([
    ...Array(3).fill("seen\n[screenshot removed]"), ...Array(3).fill("seen"),
  ]);
});
