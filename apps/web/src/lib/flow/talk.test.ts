import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFlowConfig } from "@openlive/flow-store";
import { createTalk, settleTalkMode } from "./talk";

describe("how you talk, after the move from Chat's own switch", () => {
  const moved = parseFlowConfig({ version: 8 });

  it("is push to talk for whoever had Chat's push to talk on, and hands-free for everyone else", () => {
    expect(settleTalkMode(moved, true)).toBe("ptt");
    expect(settleTalkMode(moved, false)).toBe("handsFree");
  });

  it("is left alone once decided, so a later pick is never undone", () => {
    expect(settleTalkMode(parseFlowConfig({}), true)).toBeNull();
    expect(settleTalkMode(parseFlowConfig({ talk: { mode: "ptt" } }), false)).toBeNull();
  });
});

/** createTalk with Flow and Dictate as plain flags, recording what each was told. */
function talkRig({ mode = "ptt" as "ptt" | "handsFree", silence = 30_000 as number | null, flowHears = true } = {}) {
  const log: string[] = [];
  const s = { mode, silence, flow: false, dictate: false, turn: false, dictateBusy: false, gate: null as boolean | null, holding: false };
  const talk = createTalk({
    mode: () => s.mode,
    silenceMs: () => s.silence,
    flow: {
      isOpen: () => s.flow,
      busy: () => s.turn,
      open: () => { s.flow = true; log.push("flow open"); },
      close: (reason) => { s.flow = false; log.push(`flow close ${reason}`); },
      holdStart: () => { log.push("flow hold"); return flowHears; },
      holdEnd: async (cancel) => { log.push(cancel ? "flow drop" : "flow release"); },
    },
    dictate: {
      isOpen: () => s.dictate,
      busy: () => s.dictateBusy,
      setOpen: async (on) => { s.dictate = on; log.push(`dictate ${on ? "open" : "close"}`); return ""; },
      yield: () => { s.dictate = false; log.push("dictate yield"); },
      holdStart: () => { log.push("dictate hold"); },
      holdEnd: async () => { log.push("dictate release"); },
      holdCancel: async () => { log.push("dictate drop"); },
    },
    gate: (on) => { s.gate = on; },
    holding: (on) => { s.holding = on; },
  });
  const key = (bindingId: string, kind: string) => talk.effect({ bindingId, kind });
  return { talk, s, log, key, tap: (id: "flow" | "dictate") => key(id, "double_tap") };
}

describe("Flow and Dictate as one way of talking", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens and closes each on its own double tap, and opening one closes the other", async () => {
    const r = talkRig();
    r.tap("flow");
    r.tap("dictate");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.s).toMatchObject({ flow: false, dictate: true });
    r.tap("flow");
    expect(r.s).toMatchObject({ flow: true, dictate: false });
    r.tap("flow");
    expect(r.log).toEqual(["flow open", "flow close dictate_opened", "dictate open", "flow open", "dictate yield", "flow close gesture"]);
  });

  it("in push to talk, sends each hold to whichever is open, and its end to the one it began in", async () => {
    const r = talkRig();
    r.key("ptt", "hold_start");
    expect(r.log).toEqual([]); // nothing open: dropped
    r.tap("flow");
    r.key("ptt", "hold_start");
    expect(r.s.holding).toBe(true);
    // Dictate opened mid-hold: the release still ends Flow's.
    r.tap("dictate");
    await vi.advanceTimersByTimeAsync(0);
    r.key("ptt", "hold_end");
    await vi.advanceTimersByTimeAsync(0);
    r.key("ptt", "hold_start");
    r.key("ptt", "hold_cancel");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["flow open", "flow hold", "flow close dictate_opened", "dictate open", "flow release", "dictate hold", "dictate drop"]);
    expect(r.s.holding).toBe(false);
  });

  it("ignores the key hands-free, and where Flow cannot hear it", () => {
    const free = talkRig({ mode: "handsFree" });
    free.tap("flow");
    free.key("ptt", "hold_start");
    expect(free.log).toEqual(["flow open"]);
    const deaf = talkRig({ flowHears: false });
    deaf.tap("flow");
    deaf.key("ptt", "hold_start");
    expect(deaf.s.holding).toBe(false);
  });

  it("switched mid-session, moves the gate at once, and a hold still down ends as a release with its words", async () => {
    const r = talkRig();
    r.tap("flow");
    r.talk.modeChanged();
    expect(r.s.gate).toBe(true);
    r.key("ptt", "hold_start");
    r.s.mode = "handsFree";
    r.talk.modeChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.s.gate).toBe(false);
    expect(r.log.at(-1)).toBe("flow release");
    // Its key no longer watched, a late release changes nothing.
    r.key("ptt", "hold_end");
    expect(r.log.filter((l) => l === "flow release")).toHaveLength(1);
  });

  it("closes whichever is open after the silence, never during a hold, a turn or Dictate's work", async () => {
    const r = talkRig({ silence: 30_000 });
    r.tap("dictate");
    await vi.advanceTimersByTimeAsync(0);
    r.key("ptt", "hold_start");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.s.dictate).toBe(true);
    r.key("ptt", "hold_end");
    r.s.dictateBusy = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.s.dictate).toBe(true);
    r.s.dictateBusy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.s.dictate).toBe(false);
    // Flow: a turn running holds it open; its end starts the wait again.
    r.tap("flow");
    r.talk.armSilence();
    r.s.turn = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.s.flow).toBe(true);
    r.s.turn = false;
    r.talk.armSilence();
    await vi.advanceTimersByTimeAsync(29_000);
    r.talk.speechStart(); // hands-free talk pushes it out
    await vi.advanceTimersByTimeAsync(29_000);
    expect(r.s.flow).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.log.at(-1)).toBe("flow close idle");
  });

  it("never closes on silence when set to never", async () => {
    const r = talkRig({ silence: null });
    r.tap("flow");
    r.talk.armSilence();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(r.s.flow).toBe(true);
  });

  it("cancels a hold as the machine sleeps or the screen locks", async () => {
    const r = talkRig();
    r.tap("dictate");
    await vi.advanceTimersByTimeAsync(0);
    r.key("ptt", "hold_start");
    await r.talk.cancelHold();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log.at(-1)).toBe("dictate drop");
    expect(r.s.holding).toBe(false);
  });

  it("forgets a hold in a session closed some other way", () => {
    const r = talkRig();
    r.tap("flow");
    r.key("ptt", "hold_start");
    r.talk.closed("flow");
    expect(r.s.holding).toBe(false);
    r.key("ptt", "hold_end");
    expect(r.log).not.toContain("flow release");
  });
});
