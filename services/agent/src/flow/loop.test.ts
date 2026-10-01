import { describe, expect, it, vi } from "vitest";
import { compact, estimateTokens, runFlow, type FlowRun } from "./loop.js";
import { ForwardOnlyInsertion, TEXT_TOOLS } from "../capabilities/text.js";
import { newestState, STATE_ELSEWHERE, ToolSet } from "../capabilities/dispatch.js";
import { computerTools } from "../computer/tools.js";
import type { ComputerPort } from "../computer/helper.js";
import type { DevicePort } from "../capabilities/device.js";
import type { ClipboardPort, Tool } from "../capabilities/types.js";
import type { Brain, BrainEvent, FlowEvent, Msg, TurnRequest } from "./types.js";

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
      tools: new ToolSet(TEXT_TOOLS),
      messages: [{ role: "user", text: "hi" }],
      signal: new AbortController().signal,
      session: { insert, clipboard },
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

  it("keeps a tool call's signed thinking on the assistant message, out of the event stream", async () => {
    const brain = scripted([
      [
        { type: "reasoning", delta: "check the app" },
        { type: "reasoning_signature", signature: "sig" },
        { type: "tool_start", id: "c1", name: "get_context" },
        { type: "tool_end", id: "c1", name: "get_context", args: {} },
        { type: "turn_done", stop: "tools" },
      ],
      [{ type: "text_delta", delta: "done" }, { type: "turn_done", stop: "stop" }],
    ]);
    const { run } = harness({ brain });
    const events = await collect(run);
    expect(events.map((e) => e.type)).not.toContain("error");
    expect(run.messages[1]).toMatchObject({ role: "assistant", reasoning: "check the app", reasoningSignature: "sig" });
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
    const { run } = harness({ brain });
    run.session.foreground = { async capture() { return { capturedAt: 1, app: "Mail" }; } };
    const events = await collect(run);
    expect(events.map((e) => e.type)).toEqual([
      "context", "tool_start", "tool_call", "turn_end", "tool_result",
      "context", "text_delta", "turn_end", "done",
    ]);
    expect(run.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((run.messages[2] as { result: string }).result).toContain("Mail");
  });

  it("sends the screen beside the conversation, so the system prompt and earlier messages stay byte-identical across steps", async () => {
    const reqs: TurnRequest[] = [];
    const brain = scripted([
      [{ type: "tool_start", id: "c1", name: "get_context" }, { type: "tool_end", id: "c1", name: "get_context", args: {} }, { type: "turn_done", stop: "tools" }],
      [{ type: "text_delta", delta: "done" }, { type: "turn_done", stop: "stop" }],
    ]);
    const stream = brain.stream.bind(brain);
    brain.stream = (req, signal) => { reqs.push(structuredClone(req)); return stream(req, signal); };
    const { run } = harness({ brain });
    const windows = ["Inbox", "Pull request #12"];
    run.session.foreground = { async capture() { return { capturedAt: 1, app: "Mail", windowTitle: windows.shift() }; } };
    await collect(run);
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.systemPrompt).toBe(reqs[0]!.systemPrompt);
    expect(JSON.stringify(reqs[1]!.tools)).toBe(JSON.stringify(reqs[0]!.tools));
    expect(reqs[1]!.messages.slice(0, reqs[0]!.messages.length)).toEqual(reqs[0]!.messages);
    expect(reqs.map((r) => r.tail)).toEqual([
      { text: "Right now (read from the machine, not said by the user):\napp: Mail\nwindow: Inbox" },
      { text: "Right now (read from the machine, not said by the user):\napp: Mail\nwindow: Pull request #12" },
    ]);
  });

  it("tells a session that can schedule the local time ahead of the screen, after the conversation", async () => {
    const reqs: TurnRequest[] = [];
    const brain = scripted([[{ type: "text_delta", delta: "set" }, { type: "turn_done", stop: "stop" }]]);
    const stream = brain.stream.bind(brain);
    brain.stream = (req, signal) => { reqs.push(structuredClone(req)); return stream(req, signal); };
    const remind: Tool = { name: "remind", group: "reminders", description: "", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: null }; } };
    const { run } = harness({ brain, tools: new ToolSet([...TEXT_TOOLS, remind]) });
    run.session.foreground = { async capture() { return { capturedAt: 1, app: "Mail" }; } };
    await collect(run);
    expect(reqs[0]!.tail!.text).toMatch(/^It is now \d{1,2}:\d{2} [AP]M on \w+day, [^\n]+\.\n\nRight now \(read from the machine, not said by the user\):\napp: Mail$/);
    expect(JSON.stringify(run.messages)).not.toContain("It is now");
  });

  it("keeps window trees and pictures out of the transcript and sends only the newest, after it", async () => {
    let n = 0;
    const computer: ComputerPort = {
      call: async <T>(method: string) => {
        n++;
        const snap = {
          app: { name: "Notes", bundleId: "com.apple.Notes", pid: 42, active: true },
          window: { id: 7, appName: "Notes", pid: 42, title: "Groceries", x: 0, y: 0, width: 800, height: 600, onScreen: true },
          treeText: `App: Notes (com.apple.Notes, pid 42)\nWindow: "Groceries"\n\n0 window Groceries\n\t1 button Save (tree ${n})`,
          elementCount: 2, truncated: false, screenshot: { data: `JPG${n}`, mime: "image/jpeg", width: 1280, height: 800 },
        };
        return (method === "getAppState" ? snap : { action: { path: "accessibility", actionName: "AXPress", verified: true }, state: snap }) as T;
      },
    };
    const tools = new ToolSet(computerTools({ computer, device: {} as DevicePort }));
    const call = (id: string, name: string, args: Record<string, unknown>): BrainEvent[] =>
      [{ type: "tool_start", id, name }, { type: "tool_end", id, name, args }, { type: "turn_done", stop: "tools" }];
    const reqs: TurnRequest[] = [];
    const brain = scripted([
      call("c1", "get_app_state", { app: "Notes" }),
      call("c2", "click", { element: 1 }),
      call("c3", "click", { element: 1 }),
      call("c4", "type", { text: "milk" }),
      [{ type: "text_delta", delta: "done" }, { type: "turn_done", stop: "stop" }],
    ]);
    const stream = brain.stream.bind(brain);
    brain.stream = (req, signal) => { reqs.push(structuredClone(req)); return stream(req, signal); };
    const { run } = harness({ brain, tools });
    const events = await collect(run);

    expect(reqs).toHaveLength(5);
    // Every request starts with the whole of the one before it, byte for byte.
    for (let i = 1; i < reqs.length; i++) {
      expect(JSON.stringify(reqs[i]!.messages.slice(0, reqs[i - 1]!.messages.length)), `step ${i}`).toBe(JSON.stringify(reqs[i - 1]!.messages));
      expect(reqs[i]!.systemPrompt).toBe(reqs[0]!.systemPrompt);
    }
    // The transcript never holds a tree or a picture.
    const stored = JSON.stringify(run.messages);
    expect(stored).not.toContain("button Save");
    expect(stored).not.toContain("JPG");
    expect(run.messages.filter((m) => m.role === "tool").every((m) => (m as { result: string }).result.endsWith(STATE_ELSEWHERE))).toBe(true);
    // Exactly one state per request after the first look, and always the newest.
    expect(reqs.map((r) => r.tail?.text.match(/button Save/g)?.length ?? 0)).toEqual([0, 1, 1, 1, 1]);
    expect(reqs.map((r) => /tree (\d+)/.exec(r.tail?.text ?? "")?.[1])).toEqual([undefined, "1", "2", "3", "4"]);
    expect(reqs.map((r) => r.tail?.images?.map((i) => i.data))).toEqual([undefined, ["JPG1"], ["JPG2"], ["JPG3"], ["JPG4"]]);
    expect(reqs[4]!.tail!.text).toMatch(/^The newest window state, left by type\./);
    // The orb and the session file still get everything the call returned.
    const shown = events.filter((e) => e.type === "tool_result").map((e) => (e as { content: { type: string }[] }).content.map((c) => c.type));
    expect(shown).toEqual(Array(4).fill(["text", "text", "image"]));
  });

  it("starts a fresh transcript with no window state", async () => {
    const reqs: TurnRequest[] = [];
    const brain = scripted([[{ type: "text_delta", delta: "hi" }, { type: "turn_done", stop: "stop" }]]);
    const stream = brain.stream.bind(brain);
    brain.stream = (req, signal) => { reqs.push(structuredClone(req)); return stream(req, signal); };
    const { run } = harness({ brain });
    newestState.set([], { text: "someone else's" });
    await collect(run);
    expect(reqs[0]!.tail).toBeUndefined();
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

  it("types nothing at all when consent has not been given", async () => {
    const brain = scripted([insertTurn("c1", ["dear ", "dear alice"]), [{ type: "turn_done", stop: "stop" }]]);
    const { run, chunks } = harness({ brain, approve: async () => ({ block: true, reason: "you have not given Flow permission to act on this machine yet." }) });
    const events = await collect(run);
    expect(chunks).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("types nothing before the user has answered, and the whole thing after", async () => {
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
    run.session.insert = new ForwardOnlyInsertion((_id, c) => { order.push(`typed ${c}`); chunks.push(c); });
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
    const tool: Tool = { name: "insert_text", description: "", parameters: { type: "object", properties: { text: { type: "string" } } }, execute: executed };
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
    const { run } = harness({ brain, tools: new ToolSet([tool]) });
    const events = await collect(run);
    expect(executed).not.toHaveBeenCalled();
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.every((r) => (r as { isError: boolean }).isError)).toBe(true);
    expect(run.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("stops when every tool in the batch asks to, and keeps going on a mixed batch", async () => {
    const stopper: Tool = { name: "stop_now", description: "", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: null, terminate: true }; } };
    const batch = (names: string[]): BrainEvent[] => [
      ...names.flatMap((n, i): BrainEvent[] => [
        { type: "tool_start", id: `c${i}`, name: n },
        { type: "tool_end", id: `c${i}`, name: n, args: {} },
      ]),
      { type: "turn_done", stop: "tools" },
    ];
    const tools = new ToolSet([stopper, ...TEXT_TOOLS]);

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

  it("compacts one long run of tool steps and keeps what was asked", () => {
    const step = (id: string): Msg[] => [
      { role: "assistant", text: "", toolCalls: [{ id, name: "t", arguments: "{}" }] },
      { role: "tool", callId: id, name: "t", result: "x".repeat(4_000) },
    ];
    const run: Msg[] = [{ role: "user", text: "open the PR" }, ...["1", "2", "3", "4", "5", "6"].flatMap(step)];
    const out = compact(run, { limit: 1_000, reserve: 100, tail: 3 }, null)!;
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect((out[0] as { text: string }).text).toContain("open the PR");
    // Compacting again keeps the one note rather than nesting it.
    const again = compact([...out, ...step("7"), ...step("8")], { limit: 1_000, reserve: 100, tail: 3 }, null)!;
    expect((again[0] as { text: string }).text).toBe((out[0] as { text: string }).text);
  });

  it("keeps an activated skill's instructions through every compaction, once", () => {
    const skill = '<skill_content name="pdf">\nAlways merge with qpdf.\n</skill_content>';
    const step = (id: string): Msg[] => [
      { role: "assistant", text: "", toolCalls: [{ id, name: "t", arguments: "{}" }] },
      { role: "tool", callId: id, name: "t", result: "x".repeat(4_000) },
    ];
    const run: Msg[] = [
      { role: "user", text: "merge these PDFs" },
      { role: "assistant", text: "", toolCalls: [{ id: "s", name: "activate_skill", arguments: '{"name":"pdf"}' }] },
      { role: "tool", callId: "s", name: "activate_skill", result: skill },
      ...["1", "2", "3", "4"].flatMap(step),
    ];
    const out = compact(run, { limit: 1_000, reserve: 100, tail: 3 }, null)!;
    const note = (out[0] as { text: string }).text;
    expect(note).toContain("merge these PDFs");
    expect(note).toContain("Always merge with qpdf.");
    const again = compact([...out, ...step("5"), ...step("6")], { limit: 1_000, reserve: 100, tail: 3 }, null)!;
    const next = (again[0] as { text: string }).text;
    expect(next).toBe(note);
    expect(next.split("<skill_content").length).toBe(2);
  });

  it("refuses to compact when there is nothing safe to drop", () => {
    const one: Msg[] = [{ role: "user", text: "x".repeat(100_000) }];
    expect(compact(one, { limit: 100, reserve: 10, tail: 1 }, null)).toBe(null);
  });
});
