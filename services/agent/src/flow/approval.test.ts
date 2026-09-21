import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TIERS, voiceApprove, wouldAsk } from "./approval.js";
import { flowTools } from "./tools.js";
import type { Tiers, Tool } from "./types.js";

const tools = flowTools();
const insert = tools.find((t) => t.name === "insert_text")!;
const dangerous: Tool = { ...insert, name: "wipe", tier: "destructive", risk: "dangerous" };

const ask = (answer: boolean | Promise<boolean>) => vi.fn(async () => answer);
const signal = () => new AbortController().signal;

describe("voice approval", () => {
  it("runs a safe tool in an auto tier without asking", async () => {
    const a = ask(true);
    const approve = voiceApprove({ ask: a });
    expect(await approve({ tool: insert, args: { text: "x" }, risk: "safe" }, signal())).toEqual({});
    expect(a).not.toHaveBeenCalled();
  });

  it("asks for confirm, and a yes runs", async () => {
    const approve = voiceApprove({ ask: ask(true) });
    expect(await approve({ tool: insert, args: { text: "x" }, risk: "confirm" }, signal())).toEqual({});
  });

  it("blocks on a no", async () => {
    const approve = voiceApprove({ ask: ask(false) });
    expect(await approve({ tool: insert, args: { text: "x" }, risk: "confirm" }, signal())).toMatchObject({ block: true });
  });

  it("blocks when nobody answers, because silence is not consent", async () => {
    const asker = vi.fn(() => new Promise<boolean>(() => {}));
    const approve = voiceApprove({ ask: asker, timeoutMs: 10 });
    const r = await approve({ tool: insert, args: {}, risk: "confirm" }, signal());
    expect(r).toMatchObject({ block: true });
    expect(asker.mock.calls[0]![1].aborted).toBe(true);
  });

  it("always asks for a dangerous call, whatever the tier says", async () => {
    const a = ask(true);
    const tiers: Tiers = { ...DEFAULT_TIERS, destructive: "auto" };
    await voiceApprove({ tiers, ask: a })({ tool: dangerous, args: {}, risk: "dangerous" }, signal());
    expect(a).toHaveBeenCalledOnce();
  });

  it("blocks a denied tier without asking", async () => {
    const a = ask(true);
    const tiers: Tiers = { ...DEFAULT_TIERS, insert: "deny" };
    const r = await voiceApprove({ tiers, ask: a })({ tool: insert, args: {}, risk: "safe" }, signal());
    expect(r).toMatchObject({ block: true });
    expect(a).not.toHaveBeenCalled();
  });

  it("asks when the tier says ask, even for a safe call", async () => {
    const a = ask(true);
    const tiers: Tiers = { ...DEFAULT_TIERS, insert: "ask" };
    await voiceApprove({ tiers, ask: a })({ tool: insert, args: {}, risk: "safe" }, signal());
    expect(a).toHaveBeenCalledOnce();
  });

  it("blocks immediately once the turn is cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = ask(true);
    const r = await voiceApprove({ ask: a })({ tool: insert, args: {}, risk: "confirm" }, ac.signal);
    expect(r).toMatchObject({ block: true });
    expect(a).not.toHaveBeenCalled();
  });

  it("reports what it would do without asking", () => {
    expect(wouldAsk(DEFAULT_TIERS, insert, "safe")).toBe(false);
    expect(wouldAsk(DEFAULT_TIERS, dangerous, "dangerous")).toBe(true);
  });
});
