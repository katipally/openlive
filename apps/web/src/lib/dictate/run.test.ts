import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDictate, DONE_MS, type DictatePorts, type Inserted } from "./run";
import type { DictateSnapshot } from "@/lib/flow/types";

const RULES = { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true };

/** Dictate with every port faked: the engine "hears" `said` when a hold ends. */
function rig({ mic = true, inserted = "typed" as Inserted } = {}) {
  const shown: (DictateSnapshot | null)[] = [];
  const typed: string[] = [];
  let said = "";
  let dictate: ReturnType<typeof createDictate>;
  const consumed: boolean[] = [];
  const ports: DictatePorts = {
    listen: vi.fn(async () => mic),
    beginHold: vi.fn(),
    endHold: vi.fn(async () => { if (said) consumed.push(await dictate.heard(said)); said = ""; }),
    insert: vi.fn(async (text: string) => { typed.push(text); return inserted; }),
    quietFlow: vi.fn(),
    show: (d) => void shown.push(d),
    gestureOpen: vi.fn(),
    settings: () => ({ rules: RULES, lang: "en", keys: ["Right ⌥"] }),
  };
  dictate = createDictate(ports);
  return { dictate, ports, shown, typed, consumed, say: (t: string) => { said = t; }, last: () => shown[shown.length - 1] };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("holding the key", () => {
  it("types what was said, cleaned up, and never hands it on", async () => {
    const r = rig();
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ports.beginHold).toHaveBeenCalled();
    expect(r.last()).toMatchObject({ phase: "listening", handsFree: false, keys: ["Right ⌥"] });
    r.say("um send twenty five copies to Maya by friday");
    await r.dictate.holdEnd();
    expect(r.typed).toEqual(["Send 25 copies to Maya by Friday."]);
    // Taken: the owner returns before Flow's brain ever sees the sentence.
    expect(r.consumed).toEqual([true]);
    expect(r.last()).toMatchObject({ phase: "idle", inserted: 7 });
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(r.last()).toBeNull();
  });

  it("lets Flow's turn go before it listens", () => {
    const r = rig();
    r.dictate.holdStart();
    expect(r.ports.quietFlow).toHaveBeenCalled();
  });

  it("throws away a tap's capture, so a stray tap types nothing", async () => {
    const r = rig();
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.say("half a word");
    await r.dictate.holdCancel();
    expect(r.typed).toEqual([]);
    expect(r.consumed).toEqual([true]);
    expect(r.last()).toBeNull();
  });

  it("gives the orb straight back when nothing was said", async () => {
    const r = rig();
    r.dictate.holdStart();
    await r.dictate.holdEnd();
    expect(r.typed).toEqual([]);
    expect(r.last()).toBeNull();
  });

  it("says so when the microphone will not open", async () => {
    const r = rig({ mic: false });
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ports.beginHold).not.toHaveBeenCalled();
    expect(r.last()?.note).toMatch(/microphone/);
  });

  it("copies what it could not type, and says so", async () => {
    const r = rig({ inserted: "copied" });
    r.dictate.holdStart();
    r.say("hello there friend");
    await r.dictate.holdEnd();
    expect(r.last()).toMatchObject({ inserted: 0, note: "No text box in focus. Copied instead." });
  });
});

describe("hands-free", () => {
  it("types each utterance, spaced after the first, until it is turned off", async () => {
    const r = rig();
    expect(await r.dictate.toggle()).toMatch(/^Dictation is on/);
    expect(r.ports.gestureOpen).toHaveBeenCalledWith(true);
    expect(r.last()).toMatchObject({ handsFree: true, phase: "idle" });
    expect(await r.dictate.heard("first thing here")).toBe(true);
    expect(await r.dictate.heard("second thing here")).toBe(true);
    expect(r.typed).toEqual(["First thing here.", " Second thing here."]);
    expect(await r.dictate.toggle()).toBe("Dictation is off.");
    expect(r.ports.gestureOpen).toHaveBeenLastCalledWith(false);
    expect(await r.dictate.heard("not for dictate")).toBe(false);
  });

  it("carries on from the double-tap's second press without dropping its words", async () => {
    const r = rig();
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.say("start of it all");
    await r.dictate.setHandsFree(true, true);
    expect(r.ports.gestureOpen).not.toHaveBeenCalled();
    expect(r.typed).toEqual(["Start of it all."]);
    expect(r.dictate.active()).toBe(true);
  });

  it("is not restarted by a press of the key while it is on", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    r.dictate.holdStart();
    expect(r.ports.beginHold).not.toHaveBeenCalled();
  });

  it("stops when Flow is opened over it", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    r.dictate.yield();
    expect(r.ports.gestureOpen).toHaveBeenLastCalledWith(false);
    expect(r.last()).toBeNull();
    expect(r.dictate.active()).toBe(false);
  });

  it("follows the engine between listening and waiting", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    r.dictate.hearing(true);
    expect(r.last()?.phase).toBe("listening");
    r.dictate.partial("so far");
    expect(r.last()?.partial).toBe("so far");
    r.dictate.hearing(false);
    expect(r.last()?.phase).toBe("idle");
  });
});

it("takes nothing while it is off", async () => {
  const r = rig();
  expect(await r.dictate.heard("for Flow")).toBe(false);
  expect(r.typed).toEqual([]);
});
