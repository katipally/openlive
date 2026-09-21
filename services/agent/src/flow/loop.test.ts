import { describe, expect, it, vi } from "vitest";
import { compact, estimateTokens, runFlow, type FlowRun } from "./loop.js";
import { ForwardOnlyInsertion, flowTools } from "./tools.js";
import type { Brain, BrainEvent, ClipboardPort, FlowEvent, Msg, Tool } from "./types.js";

// A brain that replays scripted turns: one array of events per turn, so a
// multi-turn run is written down rather than mocked.
function scripted(turns: BrainEvent[][]): Brain & { seen: number } {
  let turn = 0;
  return {
    id: "scripted",
    get seen() { return turn; },
    async *stream(_req, signal) {
      const events = turns[turn++] ?? [{ type: "turn_done", stop: "stop" }];
      for (const e of events) {
        if (signal.aborted) return;
        yield e;
      }
    },
  } as Brain & { seen: number };
}

const clipboard: ClipboardPort = { async read() { return ""; }, async write() {} };

function harness(over: Partial<FlowRun> & { brain: Brain }): { run: FlowRun; chunks: string[]; ended: string[]; insert: ForwardOnlyInsertion } {
  const chunks: string[] = [];
  const ended: string[] = [];
  const insert = new ForwardOnlyInsertion((_id, c) => { chunks.push(c); }, (id) => { ended.push(id); });
  return {
    chunks,
    ended,
    insert,
    run: {
      tools: flowTools(),
      messages: [{ role: "user", text: "hi" }],
      signal: new AbortController().signal,
      insert,
      clipboard,
      getSystemPrompt: () => "system",
      ...over,
    },
  };
}

const collect = async (run: FlowRun): Promise<FlowEvent[]> => {
  const out: FlowEvent[] = [];
  for await (const e of runFlow(run)) out.push(e);
  return out;
};

const doneReason = (events: FlowEvent[]) => events.find((e) => e.type === "done") as Extract<FlowEvent, { type: "done" }>;

describe("runFlow", () => {
  it("ends a turn with no tool calls", async () => {
    const { run } = harness({ brain: scripted([[{ type: "text_delta", delta: "hello" }, { type: "turn_done", stop: "stop", usage: { input: 5, output: 2 } }]]) });
    const events = await collect(run);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "turn_end", "done"]);
    expect(doneReason(events).reason).toBe("no_tools");
    expect(run.messages.at(-1)).toEqual({ role: "assistant", text: "hello", toolCalls: undefined });
  });

  it("runs tools, appends results in source order, and keeps going", async () => {
    const brain = scripted([
      [
        { type: "tool_start", id: "c1", name: "get_context" },
        { type: "tool_end", id: "c1", name: "get_context", args: {} },
        { type: "turn_done", stop: "tools" },
      ],
      [{ type: "text_delta", delta: "you are in Mail" }, { type: "turn_done", stop: "stop" }],
    ]);
    const { run } = harness({ brain, context: { async capture() { return { capturedAt: 1, app: "Mail" }; } } });
    const events = await collect(run);
    expect(events.map((e) => e.type)).toEqual([
      "context", "tool_start", "tool_call", "turn_end", "tool_result",
      "context", "text_delta", "turn_end", "done",
    ]);
    expect(run.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((run.messages[2] as { result: string }).result).toContain("Mail");
  });

  it("streams insert_text into the app before the call is finished", async () => {
    const brain = scripted([[
      { type: "tool_start", id: "c1", name: "insert_text" },
      { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear " } },
      { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear alice" } },
      { type: "tool_end", id: "c1", name: "insert_text", args: { text: "dear alice, hello" } },
      { type: "turn_done", stop: "tools" },
    ], [{ type: "turn_done", stop: "stop" }]]);
    const { run, chunks } = harness({ brain });
    await collect(run);
    expect(chunks).toEqual(["dear ", "alice", ", hello"]);
  });

  it("never re-types text the model revised after it was already sent", async () => {
    const brain = scripted([[
      { type: "tool_start", id: "c1", name: "insert_text" },
      { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear alice" } },
      { type: "tool_end", id: "c1", name: "insert_text", args: { text: "dear bob" } },
      { type: "turn_done", stop: "tools" },
    ], [{ type: "turn_done", stop: "stop" }]]);
    const { run, chunks } = harness({ brain });
    await collect(run);
    expect(chunks).toEqual(["dear alice"]);
  });

  const insertTurn = (id: string, parts: string[]): BrainEvent[] => [
    { type: "tool_start", id, name: "insert_text" },
    ...parts.map((text): BrainEvent => ({ type: "tool_args_delta", id, argsPartial: { text } })),
    { type: "tool_end", id, name: "insert_text", args: { text: parts.at(-1)! } },
    { type: "turn_done", stop: "tools" },
  ];

  it("types nothing at all when the insert tier is denied", async () => {
    const brain = scripted([insertTurn("c1", ["dear ", "dear alice"]), [{ type: "turn_done", stop: "stop" }]]);
    const { run, chunks } = harness({ brain, approve: async () => ({ block: true, reason: "insert_text is turned off in settings." }) });
    const events = await collect(run);
    expect(chunks).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("types nothing before the user answers an ask, and the whole thing after", async () => {
    const order: string[] = [];
    let asked = 0;
    const brain = scripted([insertTurn("c1", ["dear ", "dear alice"]), [{ type: "turn_done", stop: "stop" }]]);
    const { run, chunks } = harness({
      brain,
      approve: async () => {
        asked++;
        order.push("asked");
        await new Promise<void>((r) => { setTimeout(r, 5); });
        order.push("answered");
        return {};
      },
    });
    run.insert = new ForwardOnlyInsertion((_id, c) => { order.push(`typed ${c}`); chunks.push(c); });
    await collect(run);
    expect(order).toEqual(["asked", "answered", "typed dear ", "typed alice"]);
    expect(asked).toBe(1);
    expect(chunks.join("")).toBe("dear alice");
  });

  it("does not type a truncated insert again when the model retries it under a new id", async () => {
    const brain = scripted([
      [
        { type: "tool_start", id: "c1", name: "insert_text" },
        { type: "tool_args_delta", id: "c1", argsPartial: { text: "Hey Sam, thanks for the up" } },
        { type: "turn_done", stop: "length" },
      ],
      insertTurn("c2", ["Hey Sam, thanks for the update."]),
      [{ type: "turn_done", stop: "stop" }],
    ]);
    const { run, chunks } = harness({ brain });
    const events = await collect(run);
    expect(chunks.join("")).toBe("Hey Sam, thanks for the update.");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, id: "c1" });
  });

  it("closes the insertion session when the user barges in mid-call", async () => {
    const ac = new AbortController();
    const brain: Brain = {
      id: "b",
      async *stream() {
        yield { type: "tool_start", id: "c1", name: "insert_text" } as BrainEvent;
        yield { type: "tool_args_delta", id: "c1", argsPartial: { text: "dear alice" } } as BrainEvent;
        ac.abort();
        yield { type: "turn_error", message: "cancelled", aborted: true } as BrainEvent;
      },
    };
    const { run, ended, insert } = harness({ brain, signal: ac.signal });
    await collect(run);
    expect(ended).toEqual(["c1"]);
    expect(insert.committed("c1")).toBe("");
  });

  it("fails the WHOLE batch when the model ran out of room mid-call", async () => {
    const executed = vi.fn();
    const tool: Tool = { name: "insert_text", description: "", parameters: { type: "object", properties: { text: { type: "string" } } }, tier: "insert", risk: "safe", execute: executed };
    const brain = scripted([
      [
        { type: "tool_start", id: "c1", name: "insert_text" },
        { type: "tool_end", id: "c1", name: "insert_text", args: { text: "complete and valid" } },
        { type: "tool_start", id: "c2", name: "insert_text" },
        { type: "tool_end", id: "c2", name: "insert_text", args: { text: "cut off half" } },
        { type: "turn_done", stop: "length" },
      ],
      [{ type: "turn_done", stop: "stop" }],
    ]);
    const { run } = harness({ brain, tools: [tool] });
    const events = await collect(run);
    expect(executed).not.toHaveBeenCalled();
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.every((r) => (r as { isError: boolean }).isError)).toBe(true);
    expect(run.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("stops when every tool in the batch asks to, and keeps going on a mixed batch", async () => {
    const stopper: Tool = { name: "stop_now", description: "", parameters: { type: "object", properties: {} }, tier: "read", risk: "safe", async execute() { return { content: [], details: null, terminate: true }; } };
    const batch = (names: string[]): BrainEvent[] => [
      ...names.flatMap((n, i): BrainEvent[] => [
        { type: "tool_start", id: `c${i}`, name: n },
        { type: "tool_end", id: `c${i}`, name: n, args: {} },
      ]),
      { type: "turn_done", stop: "tools" },
    ];
    const tools = [stopper, ...flowTools()];

    const unanimous = harness({ brain: scripted([batch(["stop_now", "stop_now"])]), tools });
    expect(doneReason(await collect(unanimous.run)).reason).toBe("terminate");

    const mixed = harness({ brain: scripted([batch(["stop_now", "get_context"]), [{ type: "turn_done", stop: "stop" }]]), tools });
    expect(doneReason(await collect(mixed.run)).reason).toBe("no_tools");
  });

  it("obeys the host's shouldStop, since the loop owns no budget", async () => {
    const turn: BrainEvent[] = [
      { type: "tool_start", id: "c1", name: "get_context" },
      { type: "tool_end", id: "c1", name: "get_context", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    const brain = scripted([turn, turn, turn]);
    let turns = 0;
    const { run } = harness({ brain, shouldStop: () => ++turns >= 2 });
    expect(doneReason(await collect(run)).reason).toBe("host_stop");
    expect(turns).toBe(2);
  });

  it("hears a user who talks mid-run, between turns", async () => {
    const turn: BrainEvent[] = [
      { type: "tool_start", id: "c1", name: "get_context" },
      { type: "tool_end", id: "c1", name: "get_context", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    const steering: Msg[] = [{ role: "user", text: "actually, stop" }];
    const { run } = harness({ brain: scripted([turn, [{ type: "turn_done", stop: "stop" }]]), pollSteering: () => steering.splice(0) });
    await collect(run);
    expect(run.messages.filter((m) => m.role === "user").map((m) => (m as { text: string }).text)).toEqual(["hi", "actually, stop"]);
  });

  it("keeps the half of the answer the user already heard when they barge in", async () => {
    const ac = new AbortController();
    const brain: Brain = {
      id: "b",
      async *stream() {
        yield { type: "text_delta", delta: "the answer is " } as BrainEvent;
        ac.abort();
        yield { type: "turn_error", message: "cancelled", aborted: true } as BrainEvent;
      },
    };
    const { run } = harness({ brain, signal: ac.signal });
    const events = await collect(run);
    expect(doneReason(events).reason).toBe("aborted");
    expect(run.messages.at(-1)).toMatchObject({ role: "assistant", text: "the answer is " });
  });

  it("resolves a post-turn hook immediately when the user barges in during it", async () => {
    const ac = new AbortController();
    const { run } = harness({
      brain: scripted([[{ type: "text_delta", delta: "hi" }, { type: "turn_done", stop: "stop" }]]),
      signal: ac.signal,
      onTurnEnd: () => new Promise<void>(() => { ac.abort(); }),
    });
    expect(doneReason(await collect(run)).reason).toBe("no_tools");
  });

  it("ends the run on a brain error, without throwing", async () => {
    const { run } = harness({ brain: scripted([[{ type: "turn_error", message: "provider exploded", aborted: false }]]) });
    const events = await collect(run);
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", message: "provider exploded", aborted: false });
    expect(doneReason(events).reason).toBe("error");
  });
});

describe("context budget", () => {
  const usage = { index: 1, tokens: 1000 };
  const msgs: Msg[] = [
    { role: "user", text: "a".repeat(400) },
    { role: "assistant", text: "b".repeat(400) },
    { role: "user", text: "c".repeat(400) },
  ];

  it("trusts the reported usage and estimates only what came after it", () => {
    expect(estimateTokens(msgs, usage)).toBe(1100);
    expect(estimateTokens(msgs, null)).toBe(300);
  });

  it("leaves the transcript alone while it fits", () => {
    expect(compact(msgs, { limit: 10_000, reserve: 1_000, tail: 2 }, usage)).toBe(null);
  });

  it("drops the oldest messages and cuts on a user message", () => {
    const long: Msg[] = [
      { role: "user", text: "old" },
      { role: "assistant", text: "", toolCalls: [{ id: "1", name: "t", arguments: "{}" }] },
      { role: "tool", callId: "1", name: "t", result: "x".repeat(40_000) },
      { role: "user", text: "recent" },
      { role: "assistant", text: "reply" },
    ];
    const out = compact(long, { limit: 1_000, reserve: 100, tail: 3 }, null)!;
    expect(out.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect((out[0] as { text: string }).text).toContain("dropped");
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("refuses to compact when there is nothing safe to drop", () => {
    const one: Msg[] = [{ role: "user", text: "x".repeat(100_000) }];
    expect(compact(one, { limit: 100, reserve: 10, tail: 1 }, null)).toBe(null);
  });
});
