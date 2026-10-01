import { describe, expect, it, vi } from "vitest";
import { askEach, consentApprove, isDeclined, isUnanswered } from "./approval.js";
import { TEXT_TOOLS } from "./text.js";
import { FILE_TOOLS } from "./files.js";
import type { Tool } from "./types.js";

const insert = TEXT_TOOLS.find((t) => t.name === "insert_text")!;

const ask = (answer: boolean) => vi.fn(async () => answer);
const signal = () => new AbortController().signal;
const call = { tool: insert, args: { text: "x" } };

describe("consent", () => {
  it("runs without asking once it has been given", async () => {
    const a = ask(true);
    const approve = consentApprove({ granted: () => true, ask: a, remember: async () => {} });
    expect(await approve(call, signal())).toEqual({});
    expect(a).not.toHaveBeenCalled();
  });

  it("takes it once, remembers it, and never asks again", async () => {
    let granted = false;
    const a = ask(true);
    const remember = vi.fn(async () => { granted = true; });
    const approve = consentApprove({ granted: () => granted, ask: a, remember });
    expect(await approve(call, signal())).toEqual({});
    expect(await approve(call, signal())).toEqual({});
    expect(a).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledOnce();
  });

  it("asks one question for a whole batch of calls", async () => {
    const a = vi.fn(() => new Promise<boolean>((r) => setTimeout(() => r(true), 5)));
    const approve = consentApprove({ granted: () => false, ask: a, remember: async () => {} });
    const s = signal();
    expect(await Promise.all([approve(call, s), approve(call, s), approve(call, s)]))
      .toEqual([{}, {}, {}]);
    expect(a).toHaveBeenCalledOnce();
  });

  it("blocks on a no for the rest of the turn, tells the model not to nag, and asks again next turn", async () => {
    const a = ask(false);
    const opts = { granted: () => false, ask: a, remember: async () => {} };
    const approve = consentApprove(opts);
    const refused = await approve(call, signal());
    expect(refused).toMatchObject({ block: true, reason: expect.stringContaining("declined") });
    expect(refused.reason).not.toMatch(/settings/i);
    // Read back on a later turn, it must not pass for a tool that cannot work.
    expect(refused.reason).toMatch(/the tool itself works/i);
    expect(refused.reason).toMatch(/ask for it again.*call the tool again/i);
    expect(await approve(call, signal())).toEqual(refused);
    expect(a).toHaveBeenCalledOnce();
    await consentApprove(opts)(call, signal());
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("calls a Stop over the ask a cancel, not a refusal", async () => {
    const ac = new AbortController();
    const approve = consentApprove({ granted: () => false, ask: async () => { ac.abort(); return false; }, remember: async () => {} });
    expect(await approve(call, ac.signal)).toEqual({ block: true, reason: "cancelled" });
  });

  it("blocks when nobody answers, because silence is not consent", async () => {
    const asker = vi.fn(() => new Promise<boolean>(() => {}));
    const remember = vi.fn(async () => {});
    const approve = consentApprove({ granted: () => false, ask: asker, remember, timeoutMs: 10 });
    const blocked = await approve(call, signal());
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("did not answer") });
    expect([isUnanswered(blocked.reason!), isDeclined(blocked.reason!)]).toEqual([true, false]);
    expect(blocked.reason).toMatch(/ask for it again.*call the tool again/i);
    expect(asker.mock.calls[0]![1].aborted).toBe(true);
    expect(remember).not.toHaveBeenCalled();
  });

  it("blocks immediately once the turn is cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = ask(true);
    expect(await consentApprove({ granted: () => false, ask: a, remember: async () => {} })(call, ac.signal))
      .toMatchObject({ block: true });
    expect(a).not.toHaveBeenCalled();
  });
});

describe("asking per action", () => {
  const named = (name: string) => [...TEXT_TOOLS, ...FILE_TOOLS].find((t) => t.name === name)!;

  it("asks before an action that changes something, naming it, and runs it on a yes", async () => {
    const a = vi.fn(async (_q: string, _s: AbortSignal) => true);
    expect(await askEach(a)({ tool: named("write_file"), args: { path: "notes.md", content: "hi" } }, signal())).toEqual({});
    expect(a.mock.calls[0]![0]).toBe("OpenLive wants to create or overwrite notes.md (2 chars) in your workspace. Allow it?");
  });

  it("blocks only that call on a no, and says the tool still works", async () => {
    const verdict = await askEach(async () => false)({ tool: named("edit_file"), args: { path: "a.ts", find: "x", replace: "y" } }, signal());
    expect(verdict).toMatchObject({ block: true, reason: expect.stringContaining("The tool itself works") });
  });

  it("never asks for a read, or for a tool that changes nothing outside OpenLive", async () => {
    const a = vi.fn(async () => false);
    const quiet: Tool = { name: "remember", description: "", parameters: {}, async execute() { return { content: [], details: null }; } };
    for (const tool of [named("read_file"), named("list_dir"), named("clipboard_read"), named("clipboard_write"), quiet]) {
      expect(await askEach(a)({ tool, args: {} }, signal())).toEqual({});
    }
    expect(a).not.toHaveBeenCalled();
  });

  it("does not ask for a turn that was already cut off", async () => {
    const a = vi.fn(async () => true);
    expect(await askEach(a)({ tool: named("write_file"), args: { path: "x", content: "" } }, AbortSignal.abort())).toEqual({ block: true, reason: "cancelled" });
    expect(a).not.toHaveBeenCalled();
  });
});
