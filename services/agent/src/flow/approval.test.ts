import { describe, expect, it, vi } from "vitest";
import { consentApprove } from "./approval.js";
import { flowTools } from "./tools.js";

const tools = flowTools();
const insert = tools.find((t) => t.name === "insert_text")!;

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

  it("blocks on a no, and asks again next time", async () => {
    const a = ask(false);
    const approve = consentApprove({ granted: () => false, ask: a, remember: async () => {} });
    expect(await approve(call, signal())).toMatchObject({ block: true });
    expect(await approve(call, signal())).toMatchObject({ block: true });
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("blocks when nobody answers, because silence is not consent", async () => {
    const asker = vi.fn(() => new Promise<boolean>(() => {}));
    const remember = vi.fn(async () => {});
    const approve = consentApprove({ granted: () => false, ask: asker, remember, timeoutMs: 10 });
    expect(await approve(call, signal())).toMatchObject({ block: true });
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
