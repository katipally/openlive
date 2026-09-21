import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@openlive/harness";
import type { SseEvent } from "@openlive/shared";
import { DEFAULT_FLOW_CONFIG } from "@openlive/flow-store";
import { acpEventToBrain, acpTurnInput, createProviderMapper, LocalBrain, resolveFlowBrain } from "./brain.js";
import type { ResolvedLive } from "../providers.js";
import type { BrainEvent } from "./types.js";

const run = (events: ProviderEvent[]): BrainEvent[] => {
  const map = createProviderMapper();
  return events.flatMap((e) => map(e));
};

describe("provider mapping", () => {
  it("maps a plain text turn", () => {
    expect(run([
      { type: "text", delta: "hey" },
      { type: "usage", input: 10, output: 4 },
      { type: "done", stopReason: "end_turn" },
    ])).toEqual([
      { type: "text_delta", delta: "hey" },
      { type: "turn_done", stop: "stop", usage: { input: 10, output: 4 } },
    ]);
  });

  it("streams tool arguments as a growing object", () => {
    const out = run([
      { type: "tool_start", index: 0, id: "c1", name: "insert_text" },
      { type: "tool_delta", index: 0, argsDelta: '{"text":"dear ' },
      { type: "tool_delta", index: 0, argsDelta: 'alice"}' },
      { type: "tool_stop", index: 0 },
      { type: "done", stopReason: "tool_use" },
    ]);
    expect(out).toEqual([
      { type: "tool_start", id: "c1", name: "insert_text" },
      { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear " } },
      { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear alice" } },
      { type: "tool_end", id: "c1", name: "insert_text", args: { text: "dear alice" } },
      { type: "turn_done", stop: "tools", usage: { input: 0, output: 0 } },
    ]);
  });

  it("never leaves argsPartial undefined", () => {
    const out = run([
      { type: "tool_start", index: 0, id: "c1", name: "get_context" },
      { type: "tool_delta", index: 0, argsDelta: "{" },
    ]);
    expect(out[1]).toEqual({ type: "tool_args_delta", id: "c1", argsPartial: {} });
  });

  it("reports a truncated turn as length, not tools", () => {
    const out = run([
      { type: "tool_start", index: 0, id: "c1", name: "insert_text" },
      { type: "tool_delta", index: 0, argsDelta: '{"text":"half' },
      { type: "done", stopReason: "max_tokens" },
    ]);
    expect(out.at(-1)).toMatchObject({ type: "turn_done", stop: "length" });
    expect(run([{ type: "done", stopReason: "length" }]).at(-1)).toMatchObject({ stop: "length" });
  });

  it("keeps two interleaved tool calls apart and drops reasoning", () => {
    const out = run([
      { type: "reasoning", delta: "hmm" },
      { type: "tool_start", index: 0, id: "a", name: "clipboard_read" },
      { type: "tool_start", index: 1, id: "b", name: "get_context" },
      { type: "tool_delta", index: 1, argsDelta: "{}" },
      { type: "tool_delta", index: 0, argsDelta: "{}" },
      { type: "tool_stop", index: 0 },
      { type: "tool_stop", index: 1 },
    ]);
    expect(out.filter((e) => e.type === "tool_end").map((e) => (e as { id: string }).id)).toEqual(["a", "b"]);
    expect(out.some((e) => e.type === "text_delta")).toBe(false);
  });

  it("ignores deltas for a call it never saw start", () => {
    expect(run([{ type: "tool_delta", index: 7, argsDelta: "{}" }, { type: "tool_stop", index: 7 }])).toEqual([]);
  });
});

describe("LocalBrain", () => {
  const collect = async (b: LocalBrain, signal = new AbortController().signal) => {
    const out: BrainEvent[] = [];
    for await (const e of b.stream({ systemPrompt: "s", messages: [{ role: "user", text: "hi" }], tools: [] }, signal)) out.push(e);
    return out;
  };

  it("encodes a resolution failure as a terminal event instead of throwing", async () => {
    const brain = new LocalBrain(() => { throw new Error("no provider configured"); });
    expect(await collect(brain)).toEqual([{ type: "turn_error", message: "no provider configured", aborted: false }]);
  });

  it("reports an aborted stream as aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const brain = new LocalBrain(() => { throw new Error("aborted"); });
    expect(await collect(brain, ac.signal)).toEqual([{ type: "turn_error", message: "aborted", aborted: true }]);
  });
});

describe("flow brain resolution", () => {
  const base = { provider: { id: "anthropic", name: "Anthropic", protocol: "anthropic", baseURL: "x" }, model: "live-model", apiKey: "k" } as ResolvedLive;
  const cfg = (brain: Partial<typeof DEFAULT_FLOW_CONFIG.brain>) => ({ ...DEFAULT_FLOW_CONFIG, brain: { ...DEFAULT_FLOW_CONFIG.brain, ...brain } });

  it("falls through to live resolution when Flow has no preference", () => {
    expect(resolveFlowBrain(DEFAULT_FLOW_CONFIG, base)).toBe(base);
  });

  it("overrides only the model when only a model was chosen", () => {
    expect(resolveFlowBrain(cfg({ model: "flow-model" }), base)).toEqual({ ...base, model: "flow-model" });
  });

  it("ignores a provider this build does not know", () => {
    expect(resolveFlowBrain(cfg({ providerId: "not-a-provider", model: "m" }), base)).toEqual({ ...base, model: "m" });
  });
});

describe("ACP mapping", () => {
  it("sends this turn's utterances and no older one, because the agent owns its own history", () => {
    expect(acpTurnInput({
      systemPrompt: "ignored",
      tools: [],
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "second" },
      ],
    })).toEqual({ text: "second", frames: [] });
    expect(acpTurnInput({ systemPrompt: "", tools: [], messages: [] })).toEqual({ text: "", frames: [] });
  });

  it("carries every utterance the turn drained, not just the last one", () => {
    expect(acpTurnInput({
      systemPrompt: "ignored",
      tools: [],
      messages: [
        { role: "user", text: "open the PR" },
        { role: "assistant", text: "which one?" },
        { role: "user", text: "the one about coordinates" },
        { role: "user", text: "and approve it" },
      ],
    })).toEqual({ text: "the one about coordinates\nand approve it", frames: [] });
  });

  it("maps text and errors, and never turns the agent's own tools into calls for the loop", () => {
    const events: SseEvent[] = [
      { type: "text_delta", text: "on it" },
      { type: "tool_start", id: "t1", tool: "bash" },
      { type: "acp_tool_call", call: { id: "t1", title: "bash", status: "pending", kind: "execute", content: [], locations: [] } },
      { type: "tool_done", id: "t1" },
      { type: "done" },
      { type: "error", message: "agent died" },
    ];
    expect(events.map(acpEventToBrain)).toEqual([
      { type: "text_delta", delta: "on it" },
      null, null, null, null,
      { type: "turn_error", message: "agent died", aborted: false },
    ]);
  });
});
