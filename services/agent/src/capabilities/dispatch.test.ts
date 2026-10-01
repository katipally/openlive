import { describe, expect, it, vi } from "vitest";
import { asMessage, dispatch, normalizeArgs, ToolSet, validateArgs, type DispatchResult } from "./dispatch.js";
import { ForwardOnlyInsertion, TEXT_TOOLS } from "./text.js";
import { allowAll } from "./approval.js";
import type { Approve, ClipboardPort, Tool, ToolCtx } from "./types.js";

const tools = new ToolSet(TEXT_TOOLS);
const byName = (n: string) => tools.resolve(n)!;

const clipboard = (initial = ""): ClipboardPort & { value: string } => ({
  value: initial,
  async read() { return this.value; },
  async write(t: string) { this.value = t; },
});

function ctxOf(over: Partial<Omit<ToolCtx, "callId">> = {}): Omit<ToolCtx, "callId"> {
  return {
    signal: new AbortController().signal,
    context: null,
    insert: new ForwardOnlyInsertion(() => {}),
    clipboard: clipboard(),
    ...over,
  };
}

const drain = async (gen: AsyncGenerator<DispatchResult, DispatchResult[]>) => {
  const order: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { order, results: n.value };
    order.push(n.value.id);
  }
};

describe("normalizer", () => {
  it("resolves the names models actually emit", () => {
    expect(tools.resolve("insert_text")?.name).toBe("insert_text");
    expect(tools.resolve("insertText")?.name).toBe("insert_text");
    expect(tools.resolve("insert-text")?.name).toBe("insert_text");
    expect(tools.resolve("type_text")?.name).toBe("insert_text");
    expect(tools.resolve("readClipboard")?.name).toBe("clipboard_read");
    expect(tools.resolve("nonsense")).toBe(null);
  });

  it("unwraps arguments the model wrapped in itself", () => {
    expect(normalizeArgs(byName("insert_text"), { input: { text: "hi" } })).toEqual({ text: "hi" });
    expect(normalizeArgs(byName("insert_text"), { arguments: '{"text":"hi"}' })).toEqual({ text: "hi" });
  });

  it("parses a whole call handed over as a JSON string", () => {
    expect(normalizeArgs(byName("insert_text"), '{"text":"hi"}')).toEqual({ text: "hi" });
  });

  it("repairs the key spelling and the key name", () => {
    expect(normalizeArgs(byName("insert_text"), { Text: "hi" })).toEqual({ text: "hi" });
    expect(normalizeArgs(byName("insert_text"), { content: "hi" })).toEqual({ text: "hi" });
    expect(normalizeArgs(byName("clipboard_write"), { value: "hi" })).toEqual({ text: "hi" });
  });

  it("prunes anything invented, last", () => {
    expect(normalizeArgs(byName("insert_text"), { text: "hi", target: "chrome", delay: 3 })).toEqual({ text: "hi" });
    expect(normalizeArgs(byName("get_context"), { screenshot: true })).toEqual({});
  });

  it("does not invent a value it was not given", () => {
    expect(normalizeArgs(byName("insert_text"), {})).toEqual({});
    expect(normalizeArgs(byName("insert_text"), { count: 3 })).toEqual({});
  });
});

describe("validation", () => {
  const numeric: Tool = {
    name: "t", description: "",
    parameters: { type: "object", properties: { n: { type: "integer" }, ok: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, mode: { type: "string", enum: ["a", "b"] } }, required: ["n"] },
    async execute() { return { content: [], details: null }; },
  };

  it("coerces the stringified primitives models emit", () => {
    expect(validateArgs(numeric, { n: "5", ok: "true", tags: '["x"]' })).toEqual({ ok: true, value: { n: 5, ok: true, tags: ["x"] } });
  });

  it("coerces array items too", () => {
    expect(validateArgs(numeric, { n: 1, tags: [1, "b"] })).toEqual({ ok: true, value: { n: 1, tags: ["1", "b"] } });
  });

  it("rejects what cannot be coerced", () => {
    expect(validateArgs(numeric, { n: "abc" })).toMatchObject({ ok: false });
    expect(validateArgs(numeric, { n: 1.5 })).toMatchObject({ ok: false });
    expect(validateArgs(numeric, { n: 1, mode: "c" })).toMatchObject({ ok: false });
  });

  it("names a missing required argument", () => {
    const r = validateArgs(numeric, { ok: true });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("n");
  });
});

describe("forward-only insertion", () => {
  it("emits only what grew, and never rewrites what is already typed", async () => {
    const chunks: string[] = [];
    const sink = new ForwardOnlyInsertion((_id, c) => { chunks.push(c); });
    await sink.commit("c1", "dear ");
    await sink.commit("c1", "dear alice");
    await sink.commit("c1", "dear alice");       // no growth
    await sink.commit("c1", "dear bob");          // the model changed its mind: too late
    await sink.commit("c1", "dear");              // shorter: ignored
    await sink.commit("c1", "dear alice, hello");
    expect(chunks).toEqual(["dear ", "alice", ", hello"]);
    expect(sink.committed("c1")).toBe("dear alice, hello");
  });

  it("keeps two calls independent and forgets a call when it ends", async () => {
    const chunks: [string, string][] = [];
    const ended: string[] = [];
    const sink = new ForwardOnlyInsertion((id, c) => { chunks.push([id, c]); }, (id) => { ended.push(id); });
    await sink.commit("a", "one");
    await sink.commit("b", "two");
    await sink.end("a");
    await sink.end("a");
    expect(chunks).toEqual([["a", "one"], ["b", "two"]]);
    expect(ended).toEqual(["a"]);
  });

  it("the tool inserts only the remainder of text already streamed", async () => {
    const chunks: string[] = [];
    const insert = new ForwardOnlyInsertion((_id, c) => { chunks.push(c); });
    await insert.commit("c1", "hello wo");
    const res = await byName("insert_text").execute({ text: "hello world" }, { ...ctxOf({ insert }), callId: "c1" });
    expect(chunks).toEqual(["hello wo", "rld"]);
    expect(res.details).toEqual({ inserted: 11 });
  });
});

describe("the Block 3 tool set", () => {
  it("reads and writes the clipboard", async () => {
    const clip = clipboard("copied text");
    const ctx = { ...ctxOf({ clipboard: clip }), callId: "c" };
    expect((await byName("clipboard_read").execute({}, ctx)).content).toEqual([{ type: "text", text: "copied text" }]);
    await byName("clipboard_write").execute({ text: "new" }, ctx);
    expect(clip.value).toBe("new");
  });

  it("reads the selection and the context from the turn's metadata", async () => {
    const ctx = { ...ctxOf({ context: { capturedAt: 1, app: "Mail", windowTitle: "Inbox", selection: "hi there" } }), callId: "c" };
    expect((await byName("read_selection").execute({}, ctx)).content).toEqual([{ type: "text", text: "hi there" }]);
    expect((await byName("get_context").execute({}, ctx)).content[0]).toMatchObject({ text: "App: Mail\nWindow: Inbox\nSelection: hi there" });
  });

  it("says so rather than failing when there is no context", async () => {
    const ctx = { ...ctxOf(), callId: "c" };
    expect((await byName("read_selection").execute({}, ctx)).details).toEqual({ selection: "" });
    expect((await byName("get_context").execute({}, ctx)).details).toEqual({ context: null });
  });

});

describe("dispatch", () => {
  it("turns an unknown tool into a readable result instead of throwing", async () => {
    const { results } = await drain(dispatch([{ id: "1", name: "launch_missiles", args: {} }], tools, ctxOf(), { approve: allowAll }));
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0]!.content[0] as { text: string }).text).toContain("Unknown tool");
  });

  it("turns a validation failure into a result", async () => {
    const { results } = await drain(dispatch([{ id: "1", name: "insert_text", args: {} }], tools, ctxOf(), { approve: allowAll }));
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0]!.content[0] as { text: string }).text).toContain("Missing required");
  });

  it("turns a thrown error into a result", async () => {
    const boom: Tool = { name: "boom", description: "", parameters: { type: "object", properties: {} }, async execute() { throw new Error("kaboom"); } };
    const { results } = await drain(dispatch([{ id: "1", name: "boom", args: {} }], new ToolSet([boom]), ctxOf(), { approve: allowAll }));
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0]!.content[0] as { text: string }).text).toBe("kaboom");
  });

  it("turns a block into a result carrying the reason", async () => {
    const approve: Approve = async () => ({ block: true, reason: "the user said no" });
    const { results } = await drain(dispatch([{ id: "1", name: "clipboard_write", args: { text: "x" } }], tools, ctxOf(), { approve }));
    expect((results[0]!.content[0] as { text: string }).text).toBe("Blocked: the user said no");
  });

  it("treats a throwing approval hook as a block", async () => {
    const approve: Approve = async () => { throw new Error("prompt crashed"); };
    const { results } = await drain(dispatch([{ id: "1", name: "get_context", args: {} }], tools, ctxOf(), { approve }));
    expect(results[0]!.isError).toBe(true);
  });

  it("serialises preflight even while executing in parallel", async () => {
    const log: string[] = [];
    let open = 0;
    const slow: Tool = {
      name: "slow", description: "", parameters: { type: "object", properties: { i: { type: "integer" } } },
      async execute(a: { i: number }) {
        open++;
        log.push(`run${a.i}`);
        await new Promise((r) => setTimeout(r, a.i === 0 ? 20 : 1));
        expect(open).toBeGreaterThan(1);
        open--;
        return { content: [{ type: "text", text: String(a.i) }], details: a.i };
      },
    };
    const approve: Approve = async ({ args }) => { log.push(`ask${(args as { i: number }).i}`); await new Promise((r) => setTimeout(r, 5)); log.push(`answered${(args as { i: number }).i}`); return {}; };
    const calls = [0, 1].map((i) => ({ id: String(i), name: "slow", args: { i } }));
    const { order, results } = await drain(dispatch(calls, new ToolSet([slow]), ctxOf(), { approve }));
    expect(log).toEqual(["ask0", "answered0", "ask1", "answered1", "run0", "run1"]);
    // The UI sees whatever finished first; the transcript keeps source order.
    expect(order).toEqual(["1", "0"]);
    expect(results.map((r) => r.id)).toEqual(["0", "1"]);
  });

  it("runs one at a time when asked", async () => {
    const seq: string[] = [];
    const t: Tool = { name: "t", description: "", parameters: { type: "object", properties: {} }, async execute() { seq.push("x"); return { content: [], details: null }; } };
    const { order } = await drain(dispatch([{ id: "a", name: "t", args: {} }, { id: "b", name: "t", args: {} }], new ToolSet([t]), ctxOf(), { approve: allowAll, parallel: false }));
    expect(order).toEqual(["a", "b"]);
    expect(seq).toHaveLength(2);
  });

  it("does not run anything once the turn is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const execute = vi.fn();
    const t: Tool = { name: "t", description: "", parameters: { type: "object", properties: {} }, execute };
    const { results } = await drain(dispatch([{ id: "a", name: "t", args: {} }], new ToolSet([t]), ctxOf({ signal: ac.signal }), { approve: allowAll }));
    expect(execute).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ isError: true });
  });
});

describe("dispatch tally", () => {
  const ok: Tool = { name: "screenshot", description: "", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: null }; } };
  const bad: Tool = { name: "shell", description: "", parameters: { type: "object", properties: {} }, async execute() { throw new Error("nope"); } };
  const run = async (calls: { id: string; name: string; args: Record<string, unknown> }[], ctx = ctxOf()) => {
    const seen: [string | null, boolean][] = [];
    await drain(dispatch(calls, new ToolSet([ok, bad, ...TEXT_TOOLS]), ctx, { approve: allowAll, tally: (tool, failed) => { seen.push([tool, failed]); } }));
    return seen;
  };

  it("hears every call once, by the tool it resolved to and never the model's own name", async () => {
    const seen = await run([
      { id: "1", name: "screenshot", args: {} },
      { id: "2", name: "takeScreenshot", args: {} },
      { id: "3", name: "launch_missiles", args: {} },
      { id: "4", name: "shell", args: {} },
      { id: "5", name: "insert_text", args: {} },
    ]);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual(expect.arrayContaining([["screenshot", false], ["screenshot", false], [null, true], ["shell", true], ["insert_text", true]]));
  });

  it("does not call a stopped turn's cancellations failures", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await run([{ id: "1", name: "screenshot", args: {} }], ctxOf({ signal: ac.signal }))).toEqual([["screenshot", false]]);
  });

  it("is optional", async () => {
    const { results } = await drain(dispatch([{ id: "1", name: "screenshot", args: {} }], new ToolSet([ok]), ctxOf(), { approve: allowAll }));
    expect(results[0]!.isError).toBe(false);
  });
});

// ── the device actions in the repair table ──────────────────────────────────

describe("normalizing a device call", () => {
  const click: Tool = {
    name: "click", description: "",
    parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string" } }, required: ["x", "y"] },
    async execute() { return { content: [], details: null }; },
  };
  const keypress: Tool = {
    name: "keypress", description: "",
    parameters: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"] },
    async execute() { return { content: [], details: null }; },
  };

  it("splits a pair into the two numbers the tool wants", () => {
    expect(normalizeArgs(click, { coordinate: [12, 34] })).toEqual({ x: 12, y: 34 });
    expect(normalizeArgs(click, { position: { x: 5, y: 6 } })).toEqual({ x: 5, y: 6 });
  });

  it("leaves explicit coordinates alone", () => {
    expect(normalizeArgs(click, { x: 1, y: 2, coordinate: [9, 9] })).toEqual({ x: 1, y: 2 });
  });

  it("turns a written chord into the array the tool wants", () => {
    expect(normalizeArgs(keypress, { keys: "cmd+s" })).toEqual({ keys: ["cmd", "s"] });
    expect(validateArgs(keypress, normalizeArgs(keypress, { keys: "ctrl shift p" }))).toEqual({ ok: true, value: { keys: ["ctrl", "shift", "p"] } });
    expect(normalizeArgs(keypress, { keys: '["cmd","s"]' })).toEqual({ keys: '["cmd","s"]' });
  });

  it("answers to the names models reach for", () => {
    const set = new ToolSet([click, keypress]);
    expect(set.resolve("left_click")).toBe(click);
    expect(set.resolve("LeftClick")).toBe(click);
    expect(set.resolve("press_key")).toBe(keypress);
  });
});

describe("a tool set", () => {
  it("looks a name up exactly first, so a loose match never shadows a real tool", () => {
    const named = (name: string): Tool => ({ name, description: "", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: null }; } });
    const set = new ToolSet([named("open_app"), named("openApp")]);
    expect(set.resolve("openApp")!.name).toBe("openApp");
    expect(set.resolve("OPEN-APP")!.name).toBe("open_app");
    expect(set.resolve("constructor")).toBe(null);
  });

  it("hands a loop one tool message per result, pictures beside the text", () => {
    expect(asMessage({ id: "c", name: "screenshot", content: [{ type: "text", text: "Here." }, { type: "image", data: "PNG", mime: "image/png" }], details: null, isError: false, terminate: false }))
      .toEqual({ callId: "c", name: "screenshot", result: "Here.", isError: false, images: [{ data: "PNG", mime: "image/png" }] });
    expect(asMessage({ id: "c", name: "t", content: [], details: null, isError: true, terminate: false })).toEqual({ callId: "c", name: "t", result: "(no output)", isError: true });
  });
});
