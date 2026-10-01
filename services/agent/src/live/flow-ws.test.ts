import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { Msg, Tool } from "../flow/types.js";

// The session is driven exactly as the orb drives it: messages in over the
// socket, messages out over the socket. Only the two things that would reach
// outside the process are replaced: the session file and the model.

const fake = vi.hoisted(() => ({
  /** Fires the store's idle expiry, as the rolling timer would. */
  idle: null as null | (() => void),
  appended: [] as { type: string; data: Record<string, unknown> }[],
  /** Events, or a function to run at that point in the stream. */
  script: [] as unknown[],
  /** What each turn handed the brain. */
  seen: [] as Msg[][],
  /** The prompt and tools each turn handed the brain. */
  reqs: [] as { systemPrompt: string; tools: { name: string }[] }[],
  /** What the coding agent was told before its first turn. */
  preamble: "",
  /** Whether this machine has already said Flow may act. */
  consented: true,
  /** Consent written back to the config, as `updateFlowConfig` would. */
  remembered: 0,
  /** The brain the config names; unset, the default. */
  brain: null as null | Record<string, unknown>,
  /** Flow's tools as served to a coding agent, and what that agent was told was cut. */
  mcp: null as null | { tools: Tool[]; onCall?: (event: Record<string, unknown> & { type: "tool_call" | "tool_result" }) => void; ctx: () => { signal: AbortSignal } },
  cuts: [] as string[],
  /** The cuts that also told the agent its request was cancelled. */
  cancelled: [] as string[],
  /** Where the coding-agent brain reports its own tools. */
  agentTool: null as null | ((call: Record<string, unknown>, settled: boolean) => void),
}));

const store = {
  append: async (type: string, data: Record<string, unknown>) => ({ id: `entry-${fake.appended.push({ type, data })}` }),
  archive: async () => {},
};

vi.mock("@openlive/flow-store", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    readFlowConfig: () => ({
      ...(real.DEFAULT_FLOW_CONFIG as Record<string, unknown>),
      consent: { granted: fake.consented, at: "" },
      ...(fake.brain && { brain: fake.brain }),
    }),
    updateFlowConfig: async () => { fake.remembered++; fake.consented = true; },
    FlowSession: {
      open: async (opts: { onIdle?: () => void }) => { fake.idle = () => opts.onIdle?.(); return store; },
      resume: async () => store,
    },
  };
});

vi.mock("../flow/brain.js", () => {
  async function* stream(req: { messages: Msg[]; systemPrompt: string; tools: { name: string }[] }) {
    fake.seen.push(req.messages);
    fake.reqs.push(req);
    // Drained, so a turn that ran a tool asks for nothing the second time round.
    for (const step of fake.script.splice(0)) {
      if (typeof step === "function") { await (step as () => Promise<void>)(); continue; }
      yield step;
    }
  }
  return {
    LocalBrain: class { readonly id = "local"; stream = stream; },
    AcpBrain: class {
      readonly id: string;
      stream = stream;
      constructor(agent: { id: string }, _lang: unknown, onTool: typeof fake.agentTool) { this.id = agent.id; fake.agentTool = onTool; }
    },
  };
});

vi.mock("../flow/mcp.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  serveFlowMcp: async (opts: typeof fake.mcp) => { fake.mcp = opts; return { wire: {}, close: async () => {} }; },
}));

vi.mock("../agents/supervisor.js", () => ({
  AgentSupervisor: class {
    readonly id = "codex";
    constructor(make: (ask: unknown) => unknown) { make(async () => ""); }
    async start() {}
    seed() {}
    cut(spoken: string, cancelled?: boolean) { fake.cuts.push(spoken); if (cancelled) fake.cancelled.push(spoken); }
    async dispose() {}
  },
}));

vi.mock("../agents/acp-agent.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  AcpAgent: class { constructor(_id: string, _ask: unknown, opts: { preamble: string }) { fake.preamble = opts.preamble; } },
}));

vi.mock("../agents/index.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  flowAgentCwd: () => "/tmp",
}));

// The db resolves its data dir at import time, so this has to be set first.
const dataDir = mkdtempSync(join(tmpdir(), "ol-flow-ws-"));
process.env.OPENLIVE_DATA_DIR = dataDir;
afterAll(() => { delete process.env.OPENLIVE_DATA_DIR; rmSync(dataDir, { recursive: true, force: true }); });
const { FlowLiveSession, quietModeId, agentEffortOption, brainMeta } = await import("./flow-ws.js");
const { getSetting, setSetting } = await import("@openlive/db");
const { cancelledText, sentAside } = await import("../turn.js");
const { limits } = await import("../telemetry/limits.js");
const { validateEvent, validateFact } = createRequire(import.meta.url)("../../../../apps/desktop/telemetry/validate.cjs");

/** Answers the bridge the way the desktop would, so no call sits out its timeout. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, any>[] = [];
  device: (fn: string) => string = () => JSON.stringify({ value: [] });

  send(raw: string) {
    const m = JSON.parse(raw);
    this.sent.push(m);
    if (m.t !== "tool_bridge") return;
    const output = m.op === "flow_device" ? this.device(JSON.parse(m.arg).fn) : "";
    queueMicrotask(() => this.client({ t: "tool_bridge_result", reqId: m.reqId, output }));
  }

  client(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
  say(text: string) { this.client({ t: "flow_text", text }); }
}

const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

async function until(what: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !what(); i++) await tick();
  if (!what()) throw new Error("the session never got there");
}

const turnsDone = (ws: FakeSocket) => ws.sent.filter((m) => m.t === "flow" && m.event.type === "done").length;

const reply = (text: string) => [{ type: "text_delta", delta: text }, { type: "turn_done", stop: "stop" }];

beforeEach(() => {
  fake.idle = null;
  fake.appended = [];
  fake.script = [];
  fake.seen = [];
  fake.reqs = [];
  fake.preamble = "";
  fake.consented = true;
  fake.remembered = 0;
  fake.brain = null;
  fake.mcp = null;
  fake.cuts = [];
  fake.cancelled = [];
  fake.agentTool = null;
});

describe("FlowLiveSession", () => {
  it("truncates only the turn the user cut in on, never the answer before it", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = reply("It's 18 and clear in Berlin.");
    ws.say("what's the weather?");
    await until(() => turnsDone(ws) === 1);

    // Barge in before the model has said a word.
    fake.script = [async () => { ws.client({ t: "flow_cancel", spoken: "" }); await tick(); }];
    ws.say("actually-");
    await until(() => turnsDone(ws) === 2);

    fake.script = reply("Tomorrow, rain.");
    ws.say("how about tomorrow?");
    await until(() => turnsDone(ws) === 3);

    const asked = fake.seen.at(-1)!;
    expect(asked.some((m) => m.role === "assistant" && m.text === "It's 18 and clear in Berlin.")).toBe(true);
  });

  it("closes a cut run under its own number, and answers the next utterance under the next", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = [{ type: "text_delta", delta: "Opening" }, async () => {
      ws.client({ t: "flow_cancel", spoken: "" });
      ws.client({ t: "flow_text", text: "no, the other one", turn: 2 });
      fake.script = reply("Sure.");
      await tick();
    }];
    ws.client({ t: "flow_text", text: "open the file", turn: 1 });
    await until(() => turnsDone(ws) === 2);

    const events = ws.sent.filter((m) => m.t === "flow" && m.event.type !== "context").map((m) => `${m.event.type}:${m.turn}`);
    expect(events).toEqual(["text_delta:1", "error:1", "done:1", "text_delta:2", "turn_end:2", "done:2"]);
  });

  it("cuts a finished reply back to what was voiced when the user cuts in while it plays", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = reply("One. Two. Three.");
    ws.say("count to three");
    await until(() => turnsDone(ws) === 1);
    ws.client({ t: "flow_cancel", spoken: "One." });
    await tick();
    // A second cancel for the same reply, or a close, changes nothing more.
    ws.client({ t: "flow_cancel", spoken: "" });
    ws.client({ t: "flow_cancel", spoken: "", close: true });
    await tick();

    fake.script = reply("Four.");
    ws.say("go on");
    await until(() => turnsDone(ws) === 2);
    expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual(["count to three", "One.", "go on"]);
    // The file keeps the whole reply, so the cut is written after it, naming it.
    const replyAt = fake.appended.findIndex((e) => e.data.text === "One. Two. Three.");
    expect(fake.appended.filter((e) => e.type === "cut")).toEqual([{ type: "cut", data: { target: `entry-${replyAt + 1}`, text: "One." } }]);
  });

  it("closing Flow while a finished reply still plays keeps only what was voiced", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = reply("One. Two. Three.");
    ws.say("count to three");
    await until(() => turnsDone(ws) === 1);
    ws.client({ t: "flow_cancel", spoken: "One. Two", close: true });
    await tick();

    fake.script = reply("Four.");
    ws.say("go on");
    await until(() => turnsDone(ws) === 2);
    expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual(["count to three", "One. Two", "go on"]);
    expect(fake.appended.filter((e) => e.type === "cut").map((e) => e.data.text)).toEqual(["One. Two"]);
  });

  it("writes an utterance's word onsets into the transcript, and not into what the brain reads", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = reply("Done.");
    ws.client({ t: "flow_text", text: "open it", wordsAt: [820, 1010] });
    await until(() => turnsDone(ws) === 1);
    expect(fake.appended.find((e) => e.type === "message" && e.data.role === "user")!.data).toEqual({ role: "user", text: "open it", wordsAt: [820, 1010] });
    expect(fake.seen.at(-1)!.at(-1)).toEqual({ role: "user", text: "open it" });
  });

  it("keeps the transcript a running turn is writing into when the session goes idle", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = [async () => { await until(() => fake.idle !== null); fake.idle!(); await tick(); }, ...reply("Here it is.")];
    ws.say("write it up");
    await until(() => turnsDone(ws) === 1);

    expect(fake.appended.some((e) => e.type === "message" && e.data.role === "assistant" && e.data.text === "Here it is.")).toBe(true);

    // And the archived transcript is gone by the time the next utterance opens a new one.
    fake.script = reply("Fresh.");
    ws.say("and again");
    await until(() => turnsDone(ws) === 2);
    expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual(["and again"]);
  });

  it("starts the next utterance fresh on a new session, but not under a running turn", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = reply("Paris.");
    ws.say("capital of France?");
    await until(() => turnsDone(ws) === 1);

    // Asked mid-turn it is ignored: the turn keeps the transcript it is writing into.
    fake.script = [async () => { ws.client({ t: "flow_new" }); await tick(); }, ...reply("Berlin.")];
    ws.say("and Germany?");
    await until(() => turnsDone(ws) === 2);
    expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual(["capital of France?", "Paris.", "and Germany?"]);

    ws.client({ t: "flow_new" });
    await tick();
    fake.script = reply("Rome.");
    ws.say("and Italy?");
    await until(() => turnsDone(ws) === 3);
    expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual(["and Italy?"]);
  });

  it("takes consent once, out loud, when the machine never gave it", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.say("what is open?");

    const asked = await new Promise<Record<string, any>>((resolve) => {
      void until(() => {
        const m = ws.sent.find((x) => x.t === "permission");
        if (m) resolve(m);
        return !!m;
      });
    });
    expect(asked.question).toContain("act on this machine");
    ws.client({ t: "permission_response", reqId: asked.reqId, optionId: "allow" });

    await until(() => turnsDone(ws) === 1);
    expect(fake.remembered).toBe(1);
    // And the yes is the last of it: the next turn's tool is not asked about.
    fake.script = [
      { type: "tool_start", id: "c2", name: "list_windows" },
      { type: "tool_end", id: "c2", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.say("and now?");
    await until(() => turnsDone(ws) === 2);
    expect(ws.sent.filter((m) => m.t === "permission")).toHaveLength(1);
  });

  it("numbers the ask and the machine calls with the turn they belong to", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.client({ t: "flow_text", text: "what is open?", turn: 7 });
    await until(() => ws.sent.some((m) => m.t === "permission"));
    const asked = ws.sent.find((m) => m.t === "permission")!;
    expect(asked.turn).toBe(7);
    ws.client({ t: "permission_response", reqId: asked.reqId, optionId: "allow" });
    await until(() => turnsDone(ws) === 1);
    const calls = ws.sent.filter((m) => m.t === "tool_bridge");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((m) => m.turn === 7)).toBe(true);
  });

  it("refuses an open ask and ends the turn on Stop", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.say("what is open?");
    await until(() => ws.sent.some((m) => m.t === "permission"));
    const { reqId } = ws.sent.find((m) => m.t === "permission")!;

    ws.client({ t: "flow_cancel" });
    await until(() => turnsDone(ws) === 1);
    expect(ws.sent.some((m) => m.t === "permission_resolved" && m.reqId === reqId)).toBe(true);
    expect(fake.remembered).toBe(0);
    await until(() => fake.appended.some((e) => e.type === "cancel"));
    expect(fake.appended.find((e) => e.type === "cancel")!.data).toEqual({ n: 1 }); // a resume marks the request stopped again
    expect(fake.appended.find((e) => e.type === "tool_result")!.data).toEqual({ callId: "c1", name: "list_windows", isError: true, cancelled: true });
  });

  it("keeps what was only shown apart from what was spoken, and a refused tool apart from a broken one", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.client({ t: "flow_text", text: "what is open?", quiet: true });
    await until(() => ws.sent.some((m) => m.t === "permission"));
    fake.script = reply("Alright, I won't.");
    ws.client({ t: "permission_response", reqId: ws.sent.find((m) => m.t === "permission")!.reqId, optionId: "deny" });
    await until(() => turnsDone(ws) === 1);
    await until(() => fake.appended.some((e) => e.type === "message" && e.data.role === "assistant"));

    expect(fake.appended.find((e) => e.type === "tool_result")!.data).toMatchObject({ isError: true, declined: true });
    expect(fake.appended.find((e) => e.type === "message" && e.data.role === "assistant")!.data).toEqual({ role: "assistant", text: "Alright, I won't.", quiet: true });
  });

  it("asks afresh for a new request that arrives after a no, even mid-run", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);
    const listWindows = (id: string) => [
      { type: "tool_start", id, name: "list_windows" },
      { type: "tool_end", id, name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    fake.script = listWindows("c1");
    ws.say("what is open?");
    await until(() => ws.sent.some((m) => m.t === "permission"));
    fake.script = listWindows("c2");
    ws.client({ t: "permission_response", reqId: ws.sent.find((m) => m.t === "permission")!.reqId, optionId: "deny" });
    ws.say("okay fine, go ahead");
    await until(() => ws.sent.filter((m) => m.t === "permission").length === 2);
  });

  it("takes a sentence said over an unseen ask as a steer", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.client({ t: "flow_text", text: "what is open?", turn: 1 });
    await until(() => ws.sent.some((m) => m.t === "permission"));
    const { reqId } = ws.sent.find((m) => m.t === "permission")!;

    fake.script = reply("Never mind then.");
    ws.client({ t: "flow_text", text: "actually, skip that", turn: 2 });
    await until(() => turnsDone(ws) === 1);
    expect(ws.sent.some((m) => m.t === "permission_resolved" && m.reqId === reqId)).toBe(true);
    expect(fake.seen.at(-1)!.some((m) => m.role === "user" && m.text === "actually, skip that")).toBe(true);
    expect(fake.remembered).toBe(0);
  });

  it("surfaces what the machine said when it refuses, instead of calling it a timeout", async () => {
    const ws = new FakeSocket();
    ws.device = () => "Couldn't do that: the window server is not answering.";
    new FlowLiveSession(ws as never);

    fake.script = [
      { type: "tool_start", id: "c1", name: "list_windows" },
      { type: "tool_end", id: "c1", name: "list_windows", args: {} },
      { type: "turn_done", stop: "tools" },
    ];
    ws.say("what is open?");
    await until(() => turnsDone(ws) === 1);

    const result = ws.sent.find((m) => m.t === "flow" && m.event.type === "tool_result")!.event;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("the window server is not answering");
    expect(result.content[0].text).not.toContain("in time");
  });
});

describe("a coding agent as the brain", () => {
  it("writes a turn's speaker into the transcript, and not into what it reads, as the built-in brain does", async () => {
    for (const brain of [null, { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" }]) {
      fake.brain = brain;
      fake.appended = [];
      const ws = new FakeSocket();
      new FlowLiveSession(ws as never);
      fake.script = reply("Done.");
      ws.client({ t: "flow_text", text: "open it", speaker: "other 1" });
      await until(() => turnsDone(ws) === 1);
      expect(fake.appended.find((e) => e.type === "message" && e.data.role === "user")!.data).toEqual({ role: "user", text: "open it", speaker: "other 1" });
      expect(fake.seen.at(-1)!.at(-1)).toEqual({ role: "user", text: "open it" });
    }
  });

  it("answers with the built-in brain while Flow follows Chat, though the config still names an agent", async () => {
    fake.brain = { override: false, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    fake.cancelled = [];
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [async () => { ws.client({ t: "flow_cancel", close: true }); await tick(); }];
    ws.say("open Calculator");
    await until(() => turnsDone(ws) === 1);
    // Only a coding agent is told a request was cancelled; the built-in brain is not.
    expect(fake.cancelled).toEqual([]);
    ws.emit("close");
  });

  it("is told what was heard of a reply the user cut, during it or after it", async () => {
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = reply("One. Two. Three.");
    ws.say("count to three");
    await until(() => turnsDone(ws) === 1);
    ws.client({ t: "flow_cancel", spoken: "One." });

    fake.script = [{ type: "text_delta", delta: "Four" }, async () => { ws.client({ t: "flow_cancel", spoken: "" }); await tick(); }];
    ws.say("go on");
    await until(() => turnsDone(ws) === 2);
    expect(fake.cuts).toEqual(["One.", ""]);
  });

  it("tells either brain that a sentence sent on from side talk may be for someone else, and keeps it as said", async () => {
    for (const brain of [null, { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" }]) {
      fake.brain = brain;
      fake.appended = [];
      const ws = new FakeSocket();
      new FlowLiveSession(ws as never);
      fake.script = reply("I can't do that.");
      ws.client({ t: "flow_text", text: "Hey Sam, can you grab the mail", aside: true });
      await until(() => turnsDone(ws) === 1);
      expect(fake.seen.at(-1)!.at(-1)!.text).toBe(sentAside("Hey Sam, can you grab the mail"));
      expect(fake.appended.find((e) => e.type === "message")!.data).toEqual({ role: "user", text: "Hey Sam, can you grab the mail" });
      ws.emit("close");
    }
  });

  it("never picks a stopped request back up, whichever brain answers", async () => {
    for (const brain of [null, { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" }]) {
      fake.brain = brain;
      fake.cancelled = [];
      const ws = new FakeSocket();
      new FlowLiveSession(ws as never);
      fake.script = [async () => { ws.client({ t: "flow_cancel", close: true }); await tick(); }];
      ws.say("open Calculator");
      await until(() => turnsDone(ws) === 1);

      fake.script = reply("Octopuses have three hearts.");
      ws.say("three fun facts about octopuses");
      await until(() => turnsDone(ws) === 2);
      expect(fake.seen.at(-1)!.map((m) => m.text)).toEqual([cancelledText("open Calculator"), "three fun facts about octopuses"]);
      expect(fake.cancelled).toEqual(brain ? [""] : []);
      ws.emit("close");
    }
  });

  it("keeps a call stopped over its ask as stopped, not failed, whichever tool it was", async () => {
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    const own = { id: "t1", title: "Run it", kind: "execute", status: "pending", content: [], locations: [] };
    fake.script = [async () => {
      fake.agentTool!(own, false);
      ws.client({ t: "flow_cancel" });
      fake.mcp!.onCall!({ type: "tool_call", id: "c1", name: "open_app", args: {} });
      fake.mcp!.onCall!({ type: "tool_result", id: "c1", name: "open_app", content: [{ type: "text", text: "Blocked: cancelled" }], isError: true });
      fake.agentTool!({ ...own, status: "failed" }, true);
      await tick();
    }];
    ws.say("open Calculator");
    await until(() => turnsDone(ws) === 1);
    await until(() => fake.appended.filter((e) => e.type === "tool_result").length === 2);
    expect(fake.appended.filter((e) => e.type === "tool_result").map((e) => e.data.cancelled)).toEqual([true, true]);
  });

  it("refuses a tool call the agent makes between turns", async () => {
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = reply("Done.");
    ws.say("hi");
    await until(() => turnsDone(ws) === 1);
    expect(fake.mcp!.ctx().signal.aborted).toBe(true);
  });

  it("shows Flow's tool at work on the orb when the agent calls it", async () => {
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);

    fake.script = [async () => { fake.mcp!.onCall!({ type: "tool_call", id: "c1", name: "screenshot", args: {} }); await tick(); }, ...reply("Done.")];
    ws.client({ t: "flow_text", text: "look at my screen", turn: 3 });
    await until(() => turnsDone(ws) === 1);
    expect(ws.sent.find((m) => m.t === "flow" && m.event.type === "tool_start")).toEqual({ t: "flow", event: { type: "tool_start", id: "c1", name: "screenshot" }, turn: 3 });
    expect(fake.appended.some((e) => e.type === "tool_call" && e.data.name === "screenshot")).toBe(true);
  });
});

describe("OpenLive's memory in Flow", () => {
  it("is offered to either brain, through chat's own remember tool, with what it already holds", async () => {
    await setSetting("agent_notes", JSON.stringify(["Their name is Ada."]));
    // The built-in brain: the tool in its list, the notes in its prompt, and a call saves.
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [
      { type: "tool_start", id: "r1", name: "remember" },
      { type: "tool_end", id: "r1", name: "remember", args: { note: "They drink tea." } },
      { type: "turn_done", stop: "tools" },
    ];
    ws.say("remember that I drink tea");
    await until(() => turnsDone(ws) === 1);
    expect(fake.reqs[0]!.tools.map((t) => t.name)).toContain("remember");
    expect(fake.reqs[0]!.systemPrompt).toContain("Their name is Ada.");
    expect(JSON.parse(getSetting("agent_notes")!)).toEqual(["Their name is Ada.", "They drink tea."]);
    ws.emit("close");

    // A coding agent: the same tool over MCP, the notes and the rule in its preamble.
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws2 = new FakeSocket();
    new FlowLiveSession(ws2 as never);
    fake.script = reply("Noted.");
    ws2.say("hi");
    await until(() => turnsDone(ws2) === 1);
    expect(fake.preamble).toContain("They drink tea.");
    expect(fake.preamble).toContain("save it with OpenLive's remember tool, never your own memory files");
    const remember = fake.mcp!.tools.find((t) => t.name === "remember")!;
    await remember.execute({ note: "They live in Oslo." }, {} as never);
    expect(JSON.parse(getSetting("agent_notes")!)).toContain("They live in Oslo.");
    ws2.emit("close");
  });
});

describe("the coding agent's own tools", () => {
  it("show on the orb by what they do and the file they touch, and are kept without secrets", async () => {
    fake.brain = { override: true, kind: "acp", agentId: "codex", agentModel: "", agentEffort: "" };
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    const read = { id: "t1", title: "Read src/app.ts", kind: "read", status: "pending", content: [], locations: [{ path: "/tmp/src/app.ts" }] };
    const bash = { id: "t2", title: "curl -H 'x' api", kind: "execute", status: "failed", content: [], locations: [], rawInputJson: JSON.stringify({ command: "c".repeat(300), apiKey: "sk-1", timeout: 5 }) };
    fake.script = [async () => {
      fake.agentTool!(read, false);
      fake.agentTool!({ ...read, status: "completed" }, true);
      fake.agentTool!(bash, true);
      await tick();
    }, ...reply("Done.")];
    ws.client({ t: "flow_text", text: "check the app", turn: 5 });
    await until(() => turnsDone(ws) === 1);
    await until(() => fake.appended.filter((e) => e.type === "tool_result").length === 2);
    expect(ws.sent.filter((m) => m.t === "flow" && m.event.type === "tool_start"))
      .toEqual([{ t: "flow", event: { type: "tool_start", id: "t1", name: "read", kind: "read", target: "src/app.ts" }, turn: 5 }]);
    const kept = fake.appended.filter((e) => e.type === "tool_call" || e.type === "tool_result").map((e) => ({ type: e.type, ...e.data }));
    expect(kept).toEqual([
      { type: "tool_call", callId: "t1", name: "read", kind: "read", target: "src/app.ts", args: {} },
      { type: "tool_result", callId: "t1", name: "read", kind: "read", target: "src/app.ts", isError: false },
      { type: "tool_call", callId: "t2", name: "execute", kind: "execute", args: { command: `${"c".repeat(200)}…`, timeout: 5 } },
      { type: "tool_result", callId: "t2", name: "execute", kind: "execute", isError: true },
    ]);
  });
});

describe("what the coding agent is set to", () => {
  const meta = (modes: { id: string; name: string }[]) =>
    ({ models: [], currentModelId: null, modes, currentModeId: null, options: [], resumeAcrossRestart: true });

  it("takes the mode that stops the questions, not the first one that asks fewer", () => {
    expect(quietModeId(meta([{ id: "default", name: "Ask every time" }, { id: "acceptEdits", name: "Accept edits" }, { id: "bypassPermissions", name: "Bypass permissions" }])))
      .toBe("bypassPermissions");
    expect(quietModeId(meta([{ id: "default", name: "Ask" }, { id: "acceptEdits", name: "Accept edits" }]))).toBe("acceptEdits");
    expect(quietModeId(meta([{ id: "default", name: "Ask every time" }]))).toBe("");
    expect(quietModeId(null)).toBe("");
  });

  it("finds how hard it thinks among everything else it exposes", () => {
    const options = [
      { id: "cfg-model", label: "Model", category: "model_config", values: [], currentId: null },
      { id: "cfg-think", label: "Thinking", category: "thought_level", values: [{ id: "low", name: "Low" }], currentId: "low" },
    ];
    expect(agentEffortOption({ ...meta([]), options })?.id).toBe("cfg-think");
    expect(agentEffortOption({ ...meta([]), options: [] })).toBe(null);
  });
});

describe("what the header records", () => {
  const cfg = (brain: Record<string, string | boolean>) =>
    ({ brain: { override: true, kind: "api", agentId: "", agentModel: "", agentEffort: "", ...brain } }) as never;

  it("names the coding agent, its model and its effort", () => {
    expect(brainMeta(cfg({ kind: "acp", agentId: "codex", agentModel: "gpt-5.6-luna", agentEffort: "low" })))
      .toEqual({ kind: "acp", id: "codex", model: "gpt-5.6-luna", effort: "low" });
  });

  it("names Chat's API mode while Flow's own brain is switched off, whatever it names", () => {
    const live = () => ({ provider: { id: "anthropic" }, model: "opus", apiKey: "k", effort: "high" }) as never;
    expect(brainMeta(cfg({ override: false, kind: "acp", agentId: "codex", agentModel: "gpt-5.6-luna" }), live))
      .toEqual({ kind: "api", id: "anthropic", model: "opus", effort: "high" });
  });

  it("names what Chat resolved in API mode, without borrowing the agent's fields", () => {
    const live = () => ({ provider: { id: "anthropic" }, model: "opus", apiKey: "k", effort: "high" }) as never;
    expect(brainMeta(cfg({ agentModel: "gpt-5.6-luna" }), live))
      .toEqual({ kind: "api", id: "anthropic", model: "opus", effort: "high" });
    expect(brainMeta(cfg({}), () => ({ provider: { id: "ollama" }, model: "qwen3", apiKey: null }) as never))
      .toEqual({ kind: "api", id: "ollama", model: "qwen3", effort: "" });
  });
});

describe("what a Flow turn reports to main", () => {
  type Sent = { kind: "event" | "fact"; name?: string; scope?: "flow" | "call"; props: Record<string, unknown> };
  let sent: Sent[] = [];
  beforeEach(() => {
    sent = [];
    limits.clear();
    (process as unknown as { parentPort?: unknown }).parentPort = { postMessage: (m: Sent) => sent.push(m) };
  });
  afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; });

  const facts = () => sent.filter((m) => m.kind === "fact").map((m) => m.props);
  const events = (name: string) => sent.filter((m) => m.name === name).map((m) => m.props);
  /** Nothing dropped: main's validator keeps every prop, though it rounds the numbers. */
  const accepted = () => sent.every((m) => {
    const clean = m.kind === "event" ? validateEvent(m.name, m.props) : validateFact(m.scope === "flow" ? "agent_flow" : "agent_call", m.props);
    return !!clean && Object.keys(clean).sort().join() === Object.keys(m.props).sort().join();
  });
  const listWindows = (id: string) => [
    { type: "tool_start", id, name: "list_windows" },
    { type: "tool_end", id, name: "list_windows", args: {} },
    { type: "turn_done", stop: "tools" },
  ];

  it("counts each tool by group as it runs, and the turn once it ends, with the brain and its timings", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [{ type: "text_delta", delta: "Looking." }, ...listWindows("c1"), { type: "tool_start", id: "c2", name: "invented_tool" }, { type: "tool_end", id: "c2", name: "invented_tool", args: {} }];
    ws.say("what is open?");
    await until(() => turnsDone(ws) === 1);

    // Each call is counted as it settles, so an invented name is in before a real round trip is.
    expect(facts().slice(0, 2)).toEqual(expect.arrayContaining([{ tool_calls: 1, t_see: 1 }, { tool_calls: 1, tool_errors: 1 }]));
    const turn = facts().at(-1)!;
    expect(turn).toMatchObject({ brain_kind: "api", turns: 1, consent: true, agent_start_ms: 0 });
    expect(typeof turn.brain_id).toBe("string");
    expect(typeof turn.ttft_ms).toBe("number");
    expect(typeof turn.turn_ms).toBe("number");
    expect(turn).not.toHaveProperty("quiet_turns");
    expect(accepted()).toBe(true);
  });

  it("marks the first answered turn once, and a failed or cut off turn is not one", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [{ type: "turn_error", message: "HTTP 401", aborted: false, code: "auth" }];
    ws.say("first");
    await until(() => turnsDone(ws) === 1);
    expect(events("onboarding_step")).toEqual([]);

    fake.script = reply("Done.");
    ws.say("second");
    await until(() => turnsDone(ws) === 2);
    fake.script = reply("Again.");
    ws.say("third");
    await until(() => turnsDone(ws) === 3);
    expect(events("onboarding_step")).toEqual([{ step: "first_flow_reply" }, { step: "activated" }]);
    expect(accepted()).toBe(true);
  });

  it("carries the language the last sentence was spoken in, and nothing when none was said", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = reply("Hola.");
    ws.client({ t: "flow_text", text: "hola", lang: "es" });
    await until(() => turnsDone(ws) === 1);
    fake.script = reply("Done.");
    ws.say("again");
    await until(() => turnsDone(ws) === 2);
    expect(facts().filter((f) => f.turns).map((f) => f.lang)).toEqual(["es", undefined]);
    expect(accepted()).toBe(true);
  });

  it("counts a quiet turn", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = reply("Done.");
    ws.client({ t: "flow_text", text: "do a thing", quiet: true });
    await until(() => turnsDone(ws) === 1);
    expect(facts().at(-1)).toMatchObject({ turns: 1, quiet_turns: 1 });
    expect(accepted()).toBe(true);
  });

  it("counts a sentence that steers a running turn, and the turn it then becomes", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [async () => { ws.say("and also this"); await tick(); }, ...reply("Done.")];
    ws.say("do a thing");
    await until(() => turnsDone(ws) >= 2);
    expect(facts().filter((f) => f.steered)).toEqual([{ steered: 1 }]);
    expect(facts().filter((f) => f.turns)).toHaveLength(2);
    expect(accepted()).toBe(true);
  });

  it("reports a failed brain turn as an error fact and one event per class, with no turn time", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    const fail = { type: "turn_error", message: "HTTP 401: the key is wrong", aborted: false, code: "auth" };
    fake.script = [fail];
    ws.say("first");
    await until(() => turnsDone(ws) === 1);
    fake.script = [fail];
    ws.say("second");
    await until(() => turnsDone(ws) === 2);

    expect(events("brain_error")).toEqual([expect.objectContaining({ surface: "flow", class: "auth", brain_kind: "api", http_class: "4xx" })]);
    expect(facts().filter((f) => f.errors)).toEqual([{ errors: 1 }, { errors: 1 }]);
    expect(facts().at(-1)).not.toHaveProperty("turn_ms");
    expect(ws.sent.find((m) => m.t === "flow" && m.event.type === "error")!.event).toMatchObject({ code: "auth", aborted: false });
    expect(accepted()).toBe(true);
  });

  it("does not report a turn the user cut off as a failure, or time it", async () => {
    const ws = new FakeSocket();
    new FlowLiveSession(ws as never);
    fake.script = [{ type: "text_delta", delta: "Opening" }, async () => { ws.client({ t: "flow_cancel", spoken: "" }); await tick(); }];
    ws.say("open the file");
    await until(() => turnsDone(ws) === 1);
    expect(events("brain_error")).toEqual([]);
    expect(facts().some((f) => f.errors)).toBe(false);
    expect(facts().at(-1)).toMatchObject({ turns: 1, ttft_ms: expect.any(Number) });
    expect(facts().at(-1)).not.toHaveProperty("turn_ms");
  });

  it("reports the spoken consent answer, and the step the first yes is", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);
    fake.script = listWindows("c1");
    ws.say("what is open?");
    await until(() => ws.sent.some((m) => m.t === "permission"));
    ws.client({ t: "permission_response", reqId: ws.sent.find((m) => m.t === "permission")!.reqId, optionId: "allow" });
    await until(() => turnsDone(ws) === 1);

    expect(events("flow_consent_result")).toEqual([{ outcome: "granted", brain_kind: "api" }]);
    expect(events("onboarding_step")).toEqual([{ step: "flow_consent_granted" }, { step: "first_flow_reply" }, { step: "activated" }]);
    expect(facts().at(-1)).toMatchObject({ consent: true });
    expect(accepted()).toBe(true);
  });

  it("reports a refusal as declined, and says nothing when the turn was cut off mid-ask", async () => {
    const ws = new FakeSocket();
    fake.consented = false;
    new FlowLiveSession(ws as never);
    fake.script = listWindows("c1");
    ws.say("what is open?");
    await until(() => ws.sent.some((m) => m.t === "permission"));
    fake.script = reply("Alright.");
    ws.client({ t: "permission_response", reqId: ws.sent.find((m) => m.t === "permission")!.reqId, optionId: "deny" });
    await until(() => turnsDone(ws) === 1);
    expect(events("flow_consent_result")).toEqual([{ outcome: "declined", brain_kind: "api" }]);
    expect(events("onboarding_step")).toEqual([{ step: "first_flow_reply" }, { step: "activated" }]);
    expect(facts().at(-1)).toMatchObject({ consent: false });

    sent = [];
    fake.script = listWindows("c2");
    ws.say("try again");
    await until(() => ws.sent.filter((m) => m.t === "permission").length === 2);
    ws.client({ t: "flow_cancel" });
    await until(() => turnsDone(ws) === 2);
    expect(events("flow_consent_result")).toEqual([]);
  });
});
