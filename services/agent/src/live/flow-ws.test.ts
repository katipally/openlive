import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Msg } from "../flow/types.js";

// The session is driven exactly as the pill drives it: messages in over the
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
}));

const store = {
  append: async (type: string, data: Record<string, unknown>) => { fake.appended.push({ type, data }); },
  archive: async () => {},
};

vi.mock("@openlive/flow-store", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    readFlowConfig: () => real.DEFAULT_FLOW_CONFIG,
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

const { FlowLiveSession } = await import("./flow-ws.js");

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

});
