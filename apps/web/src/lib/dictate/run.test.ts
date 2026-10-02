import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MS, createDictate, DONE_MS, POLISH_MS, UNDO_MS, type DictatePorts, type DictateSettings, type Inserted, type RewriteAsk } from "./run";
import type { SpokenCommand } from "./words";
import type { DictateSnapshot } from "@/lib/flow/types";

const RULES = { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true };

/** Dictate with every port faked: the engine "hears" `said` when a hold ends. */
function rig({ voided = false, mic = true, inserted = "typed" as Inserted, settings = {} as Partial<DictateSettings>, rewrite = async (ask: RewriteAsk) => `REWRITTEN ${ask.text}`, selection = "" } = {}) {
  const shown: (DictateSnapshot | null)[] = [];
  const typed: string[] = [];
  const pressed: [string[], number | undefined][] = [];
  const asked: RewriteAsk[] = [];
  const kept: unknown[] = [];
  let said = "";
  let dictate: ReturnType<typeof createDictate>;
  const consumed: boolean[] = [];
  const ports: DictatePorts = {
    listen: vi.fn(async () => mic),
    beginHold: vi.fn(),
    // `voided`: as the owner does, the words are handed over and not waited on.
    endHold: vi.fn(async () => { if (said && voided) void dictate.heard(said); else if (said) consumed.push(await dictate.heard(said)); said = ""; }),
    insert: vi.fn(async (text: string) => { typed.push(text); return inserted; }),
    quietFlow: vi.fn(),
    show: (d) => void shown.push(d),
    gestureOpen: vi.fn(),
    rewrite: vi.fn(async (ask: RewriteAsk) => { asked.push(ask); return rewrite(ask); }),
    warm: vi.fn(),
    selection: vi.fn(async () => selection),
    keys: vi.fn(async (keys: string[], times?: number) => { pressed.push([keys, times]); return true; }),
    record: (d) => void kept.push(d),
    settings: () => ({
      rules: RULES, lang: "en", keys: ["Right ⌥"], commandKeys: ["⇧", "Right ⌥"], words: [], snippets: [],
      commands: new Set<SpokenCommand>(["enter", "newLine", "newParagraph", "undo", "stop"]), polish: { enabled: false, tone: "natural" }, ...settings,
    }),
  };
  dictate = createDictate(ports);
  return { dictate, ports, shown, typed, pressed, asked, kept, consumed, say: (t: string) => { said = t; }, last: () => shown[shown.length - 1] };
}

/** A hold that says `text`, start to finish. */
async function hold(r: ReturnType<typeof rig>, text: string, command = false) {
  r.dictate.holdStart(command);
  await vi.advanceTimersByTimeAsync(0);
  r.say(text);
  await r.dictate.holdEnd();
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
    expect(r.last()).toMatchObject({ phase: "idle", inserted: 7, undo: true });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(r.last()).toBeNull();
  });

  it("keeps the orb up until words handed over unawaited are typed, then lets it go", async () => {
    let answer = (_: string) => {};
    const r = rig({ voided: true, settings: { polish: { enabled: true, tone: "natural" } }, rewrite: () => new Promise<string>((ok) => { answer = ok; }) });
    const released = hold(r, "send it friday");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.last()).toMatchObject({ phase: "processing" });
    answer("Send it Friday.");
    await released;
    expect(r.typed).toEqual(["Send it Friday."]);
    expect(r.last()).toMatchObject({ phase: "idle", inserted: 3 });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(r.last()).toBeNull();
  });

  it("types hands-free utterances in the order they were said, however slow the first polish", async () => {
    const answers: ((t: string) => void)[] = [];
    const r = rig({ settings: { polish: { enabled: true, tone: "natural" } }, rewrite: () => new Promise<string>((ok) => { answers.push(ok); }) });
    await r.dictate.setHandsFree(true, true);
    const first = r.dictate.heard("first one");
    const second = r.dictate.heard("second one");
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);
    answers[0]!("First.");
    await vi.advanceTimersByTimeAsync(0);
    answers[1]!("Second.");
    await Promise.all([first, second]);
    expect(r.typed).toEqual(["First.", " Second."]);
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

describe("the word lists", () => {
  it("spells dictionary words the user's way, and keeps the dictation in history", async () => {
    const r = rig({ settings: { words: ["OpenLive"] } });
    await hold(r, "i love open live");
    expect(r.typed).toEqual(["I love OpenLive."]);
    expect(r.kept).toEqual([{ raw: "i love open live", cleaned: "I love OpenLive.", final: "I love OpenLive.", copied: false }]);
  });

  it("types a snippet's text for its trigger said alone, never polished", async () => {
    const r = rig({ settings: { snippets: [{ trigger: "my address", text: "221B Baker Street" }], polish: { enabled: true, tone: "formal" } } });
    await hold(r, "my address");
    expect(r.typed).toEqual(["221B Baker Street"]);
    expect(r.asked).toEqual([]);
  });
});

describe("AI polish", () => {
  const on = { polish: { enabled: true, tone: "casual" as const } };

  it("types the brain's rewrite of the cleaned-up words, warming it on the press", async () => {
    const r = rig({ settings: on });
    await hold(r, "um send it by friday");
    expect(r.ports.warm).toHaveBeenCalled();
    expect(r.asked).toEqual([{ kind: "polish", text: "Send it by Friday.", tone: "casual" }]);
    expect(r.typed).toEqual(["REWRITTEN Send it by Friday."]);
  });

  it("falls back to the cleaned-up words when the brain fails, API or agent alike", async () => {
    const r = rig({ settings: on, rewrite: async () => { throw new Error("No API key for OpenAI."); } });
    await hold(r, "send it by friday");
    expect(r.typed).toEqual(["Send it by Friday."]);
    expect(r.last()?.note).toMatch(/did not answer/);
  });

  it("falls back to the cleaned-up words once it takes too long, and hangs up on the brain", async () => {
    let signal: AbortSignal | undefined;
    const r = rig({ settings: on });
    r.ports.rewrite = vi.fn((_ask: RewriteAsk, s: AbortSignal) => { signal = s; return new Promise<string>(() => {}); });
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.say("send it by friday");
    const done = r.dictate.holdEnd();
    await vi.advanceTimersByTimeAsync(POLISH_MS);
    await done;
    expect(signal?.aborted).toBe(true);
    expect(r.typed).toEqual(["Send it by Friday."]);
  });

  it("falls back on an empty answer too", async () => {
    const r = rig({ settings: on, rewrite: async () => "  " });
    await hold(r, "send it by friday");
    expect(r.typed).toEqual(["Send it by Friday."]);
  });
});

describe("spoken commands", () => {
  it("presses Enter after typing what came before it", async () => {
    const r = rig();
    await hold(r, "Sounds good. Press enter.");
    expect(r.typed).toEqual(["Sounds good."]);
    expect(r.pressed).toEqual([[["enter"], undefined]]);
  });

  it("types the words when they are part of the sentence", async () => {
    const r = rig();
    await hold(r, "I will press enter later");
    expect(r.typed).toEqual(["I will press enter later."]);
    expect(r.pressed).toEqual([]);
  });

  it("breaks the line with Shift+Enter, and the next words start it with no space", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    await r.dictate.heard("first line");
    await r.dictate.heard("new paragraph");
    await r.dictate.heard("second line");
    expect(r.pressed).toEqual([[["shift", "enter"], 2]]);
    expect(r.typed).toEqual(["First line", "Second line"]);
  });

  it("takes back the last insertion with one Backspace per character, once", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    await r.dictate.heard("send it");
    await r.dictate.heard("and more 👍");
    await r.dictate.heard("undo that");
    expect(r.pressed).toEqual([[["backspace"], " And more 👍".length - 1]]);
    await r.dictate.heard("undo that");
    expect(r.pressed).toHaveLength(1);
    expect(r.last()?.note).toMatch(/Nothing/);
  });

  it("offers Undo on the orb after an insertion, which takes it back once", async () => {
    const r = rig();
    await hold(r, "send it");
    expect(r.last()).toMatchObject({ inserted: 2, undo: true });
    await Promise.all([r.dictate.undo(), r.dictate.undo()]);
    expect(r.pressed).toEqual([[["backspace"], r.typed[0]!.length]]);
    expect(r.last()).toMatchObject({ undo: false, inserted: 0, note: "Took it back" });
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(r.last()).toBeNull();
  });

  it("stops offering Undo after a few seconds, or once the next words start", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    await r.dictate.heard("send it");
    expect(r.last()?.undo).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(r.last()).toMatchObject({ undo: false, inserted: 2 });
    await r.dictate.undo();
    expect(r.pressed).toEqual([]);
    await r.dictate.heard("and more");
    r.dictate.partial("then");
    expect(r.last()?.undo).toBe(false);
    // Nothing typed, nothing offered.
    const copied = rig({ inserted: "copied" });
    await hold(copied, "send it");
    expect(copied.last()?.undo).toBe(false);
  });

  it("stops hands-free on \"stop dictating\", and only hands-free", async () => {
    const r = rig();
    await r.dictate.setHandsFree(true, false);
    await r.dictate.heard("that is all. stop dictating");
    expect(r.typed).toEqual(["That is all."]);
    expect(r.dictate.active()).toBe(false);
    const held = rig();
    await hold(held, "stop dictating");
    expect(held.typed).toEqual(["Stop dictating"]);
  });

  it("leaves another language as said", async () => {
    const r = rig({ settings: { lang: "es" } });
    await hold(r, "press enter");
    expect(r.typed).toEqual(["press enter"]);
  });
});

describe("command mode", () => {
  it("rewrites the selection as told and types over it", async () => {
    const r = rig({ selection: "hey can u send the numbers", rewrite: async () => "Could you send the numbers?" });
    await hold(r, "um make it polite", true);
    expect(r.ports.warm).toHaveBeenCalled();
    expect(r.asked).toEqual([{ kind: "command", text: "Make it polite.", selection: "hey can u send the numbers" }]);
    expect(r.typed).toEqual(["Could you send the numbers?"]);
    expect(r.kept).toEqual([{ raw: "um make it polite", cleaned: "Make it polite.", final: "Could you send the numbers?", command: true, copied: false }]);
  });

  it("writes at the cursor when nothing is selected, and shows it is a command", async () => {
    const r = rig({ rewrite: async () => "A haiku." });
    r.dictate.holdStart(true);
    expect(r.last()).toMatchObject({ command: true, keys: ["⇧", "Right ⌥"] });
    await vi.advanceTimersByTimeAsync(0);
    r.say("write a haiku");
    await r.dictate.holdEnd();
    expect(r.asked[0]).toMatchObject({ selection: "" });
    expect(r.typed).toEqual(["A haiku."]);
  });

  it("changes nothing when the brain fails or runs out of time", async () => {
    const r = rig({ selection: "keep me", rewrite: async () => { throw new Error("rate limited"); } });
    await hold(r, "make it formal", true);
    expect(r.typed).toEqual([]);
    expect(r.last()?.note).toBe("rate limited");
    const slow = rig({ selection: "keep me" });
    slow.ports.rewrite = vi.fn(() => new Promise<string>(() => {}));
    slow.dictate.holdStart(true);
    await vi.advanceTimersByTimeAsync(0);
    slow.say("make it formal");
    const done = slow.dictate.holdEnd();
    await vi.advanceTimersByTimeAsync(COMMAND_MS);
    await done;
    expect(slow.typed).toEqual([]);
    expect(slow.last()?.note).toMatch(/nothing changed/);
  });

  it("says a selection is too long instead of sending what the brain would refuse", async () => {
    // Over the length, and under it but over the body once JSON escapes it.
    for (const selection of ["a".repeat(20_001), "\u0007".repeat(12_000)]) {
      const r = rig({ selection });
      await hold(r, "make it formal", true);
      expect(r.asked).toEqual([]);
      expect(r.typed).toEqual([]);
      expect(r.last()).toMatchObject({ phase: "idle", note: "Selection too long for a command." });
    }
  });

  it("takes over a plain hold when Shift joins it", async () => {
    const r = rig({ rewrite: async () => "Done." });
    r.dictate.holdStart();
    r.dictate.holdStart(true);
    await vi.advanceTimersByTimeAsync(0);
    r.say("fix the typo");
    await r.dictate.holdEnd();
    expect(r.asked[0]?.kind).toBe("command");
  });
});
