import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Msg } from "../flow/types.js";

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
  /** Whether this machine has already said Flow may act. */
  consented: true,
  /** Consent written back to the config, as `updateFlowConfig` would. */
  remembered: 0,
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
    }),
    updateFlowConfig: async () => { fake.remembered++; fake.consented = true; },
    FlowSession: {
      open: async (opts: { onIdle?: () => void }) => { fake.idle = () => opts.onIdle?.(); return store; },
      resume: async () => store,
    },
  };
});

vi.mock("../flow/brain.js", () => ({
  LocalBrain: class {
    readonly id = "local";
    async *stream(req: { messages: Msg[] }) {
      fake.seen.push(req.messages);
      // Drained, so a turn that ran a tool asks for nothing the second time round.
      for (const step of fake.script.splice(0)) {
        if (typeof step === "function") { await (step as () => Promise<void>)(); continue; }
        yield step;
      }
    }
  },
  AcpBrain: class { readonly id = "acp"; },
}));

const { FlowLiveSession, quietModeId, agentEffortOption, brainMeta } = await import("./flow-ws.js");

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
  fake.consented = true;
  fake.remembered = 0;
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
  const cfg = (brain: Record<string, string>) =>
    ({ brain: { kind: "api", agentId: "", agentModel: "", agentEffort: "", ...brain } }) as never;

  it("names the coding agent, its model and its effort", () => {
    expect(brainMeta(cfg({ kind: "acp", agentId: "codex", agentModel: "gpt-5.6-luna", agentEffort: "low" })))
      .toEqual({ kind: "acp", id: "codex", model: "gpt-5.6-luna", effort: "low" });
  });

  it("names what Chat resolved in API mode, without borrowing the agent's fields", () => {
    const live = () => ({ provider: { id: "anthropic" }, model: "opus", apiKey: "k", effort: "high" }) as never;
    expect(brainMeta(cfg({ agentModel: "gpt-5.6-luna" }), live))
      .toEqual({ kind: "api", id: "anthropic", model: "opus", effort: "high" });
    expect(brainMeta(cfg({}), () => ({ provider: { id: "ollama" }, model: "qwen3", apiKey: null }) as never))
      .toEqual({ kind: "api", id: "ollama", model: "qwen3", effort: "" });
  });
});
