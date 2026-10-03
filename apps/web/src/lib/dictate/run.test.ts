import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MS, createDictate, DONE_MS, NO_EDIT_BRAIN, NO_SPEECH, POLISH_MS, readRewrite, UNDO_MS, type DictatePorts, type DictateSettings, type Inserted, type RewriteAsk } from "./run";
import type { SpokenCommand } from "./words";
import type { DictateSnapshot } from "@/lib/flow/types";
import type { HoldEnd } from "@/lib/live/voiceEngine";

const RULES = { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true };

/** Dictate with every port faked: the engine "hears" `said` when a hold ends.
 *  `selection`: what the accessibility API reads each time it is asked, the
 *  last one standing for every read after it. */
function rig({ voided = false, mic = true as boolean | "" | Promise<boolean>, held = "heard" as HoldEnd, inserted = "typed" as Inserted, ended = true, settings = {} as Partial<DictateSettings>, rewrite = async (ask: RewriteAsk) => `REWRITTEN ${ask.text}`, selection = [""] as (string | null)[] } = {}) {
  const shown: (DictateSnapshot | null)[] = [];
  const typed: string[] = [];
  const pressed: [string[], number | undefined][] = [];
  const asked: RewriteAsk[] = [];
  const kept: unknown[] = [];
  const reads = [...selection];
  let said = "";
  let dictate: ReturnType<typeof createDictate>;
  const consumed: boolean[] = [];
  const ports: DictatePorts = {
    listen: vi.fn(async () => mic),
    ready: vi.fn(() => mic === true),
    beginHold: vi.fn(),
    dropHold: vi.fn(),
    // `voided`: as the owner does, the words are handed over and not waited on.
    endHold: vi.fn(async (_lateMs: number) => { if (said && voided) void dictate.heard(said); else if (said) consumed.push(await dictate.heard(said)); said = ""; return held; }),
    // Pushed pieces land as one insertion once ended; "copied" and "failed" have no text box.
    typing: vi.fn(async () => {
      if (inserted !== "typed") return null;
      let text = "";
      return { push: vi.fn(async (t: string) => { text += t; }), end: vi.fn(async () => { typed.push(text); return ended; }) };
    }),
    copy: vi.fn(async () => inserted !== "failed"),
    release: vi.fn(),
    show: (d) => void shown.push(d),
    rewrite: vi.fn(async (ask: RewriteAsk, _signal: AbortSignal, _onText: (t: string) => void) => { asked.push(ask); return rewrite(ask); }),
    warm: vi.fn(),
    selection: vi.fn(async () => (reads.length > 1 ? reads.shift()! : reads[0] ?? null)),
    keys: vi.fn(async (keys: string[], times?: number) => { pressed.push([keys, times]); return true; }),
    record: (d) => void kept.push(d),
    settings: () => ({
      rules: RULES, lang: "en", words: [], snippets: [],
      commands: new Set<SpokenCommand>(["enter", "newLine", "newParagraph", "undo", "stop"]), polish: { enabled: false, tone: "natural" }, canEdit: true, ...settings,
    }),
  };
  dictate = createDictate(ports);
  return { dictate, ports, shown, typed, pressed, asked, kept, consumed, say: (t: string) => { said = t; }, last: () => shown[shown.length - 1] };
}

/** A push-to-talk hold that says `text`, start to finish, in a session opened for it if need be. */
async function hold(r: ReturnType<typeof rig>, text: string) {
  if (!r.dictate.isOpen()) await r.dictate.setOpen(true);
  r.dictate.holdStart();
  await vi.advanceTimersByTimeAsync(0);
  r.say(text);
  await r.dictate.holdEnd();
}

/** A hands-free utterance: speech starts, then its words are heard. */
async function utter(r: ReturnType<typeof rig>, text: string) {
  r.dictate.speechStart();
  await vi.advanceTimersByTimeAsync(0);
  return r.dictate.heard(text);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("a session", () => {
  it("opens, holds the microphone until it is closed, and lets it go at once", async () => {
    const r = rig();
    expect(await r.dictate.setOpen(true)).toMatch(/^Dictation is on/);
    expect(r.ports.listen).toHaveBeenCalledTimes(1);
    expect(r.last()).toMatchObject({ phase: "idle", editing: false, ready: true });
    await hold(r, "send it friday");
    await utter(r, "and more");
    expect(r.ports.listen).toHaveBeenCalledTimes(1);
    expect(r.ports.release).not.toHaveBeenCalled();
    expect(await r.dictate.setOpen(false)).toBe("Dictation is off.");
    expect(r.ports.release).toHaveBeenCalledTimes(1);
    // Closed by the person: the orb goes back at once, Undo or not.
    expect(r.last()).toBeNull();
    expect(r.dictate.active()).toBe(false);
  });

  it("takes nothing while it is closed, and ignores the push-to-talk key", async () => {
    const r = rig();
    expect(await r.dictate.heard("for Flow")).toBe(false);
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ports.beginHold).not.toHaveBeenCalled();
    expect(r.typed).toEqual([]);
    expect(r.shown).toEqual([]);
  });

  it("says so when the microphone will not open, and closes", async () => {
    const r = rig({ mic: false });
    expect(await r.dictate.setOpen(true)).toMatch(/microphone/);
    expect(r.last()?.note).toMatch(/microphone/);
    expect(r.dictate.isOpen()).toBe(false);
    await vi.advanceTimersByTimeAsync(DONE_MS);
    expect(r.last()).toBeNull();
  });

  it("closes at once without a note when the owner asks something on the orb instead, as for a download", async () => {
    const r = rig({ mic: "" });
    expect(await r.dictate.setOpen(true)).toMatch(/download the voice models/);
    expect(r.dictate.isOpen()).toBe(false);
    expect(r.last()).toBeNull();
  });

  it("says Getting ready while the engine starts, and a hold made meanwhile waits for it with its words kept", async () => {
    let up!: (ok: boolean) => void;
    const r = rig({ mic: new Promise<boolean>((ok) => { up = ok; }) });
    const opened = r.dictate.setOpen(true);
    expect(r.last()).toMatchObject({ ready: false });
    r.dictate.holdStart();
    r.say("send it friday");
    const released = r.dictate.holdEnd();
    up(true);
    await Promise.all([opened, released]);
    expect(r.ports.beginHold).toHaveBeenCalledTimes(1);
    expect(r.typed).toEqual(["Send it Friday."]);
    expect(r.last()).toMatchObject({ phase: "idle", inserted: 3, undo: true, ready: true });
  });

  it("stops when Flow is opened over it, letting go of a hold in progress so Flow ends its own turns", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.dictate.yield();
    expect(r.ports.dropHold).toHaveBeenCalledTimes(1);
    expect(r.ports.release).toHaveBeenCalledTimes(1);
    expect(r.last()).toBeNull();
    expect(r.dictate.active()).toBe(false);
    // The key coming up afterwards is nothing to Dictate.
    await r.dictate.holdEnd();
    expect(r.ports.endHold).not.toHaveBeenCalled();
  });

  it("is busy while a hold is down or an utterance is worked on, so silence does not close it then", async () => {
    let answer = (_: string) => {};
    const r = rig({ voided: true, settings: { polish: { enabled: true, tone: "natural" } }, rewrite: () => new Promise<string>((ok) => { answer = ok; }) });
    await r.dictate.setOpen(true);
    expect(r.dictate.busy()).toBe(false);
    r.dictate.holdStart();
    expect(r.dictate.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    r.say("send it friday");
    const released = r.dictate.holdEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.dictate.busy()).toBe(true);
    answer("Send it Friday.");
    await released;
    expect(r.dictate.busy()).toBe(false);
  });
});

describe("push to talk", () => {
  it("types each hold, cleaned up, spaced after the first, and stays open between them", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    r.dictate.holdStart();
    expect(r.last()).toMatchObject({ phase: "listening" });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ports.beginHold).toHaveBeenCalled();
    r.say("um send twenty five copies to Maya by friday");
    await r.dictate.holdEnd();
    // Taken: the owner returns before Flow's brain ever sees the sentence.
    expect(r.consumed).toEqual([true]);
    expect(r.last()).toMatchObject({ phase: "idle", inserted: 7, undo: true, partial: "" });
    expect(r.shown).toContainEqual(expect.objectContaining({ phase: "processing", partial: "Send 25 copies to Maya by Friday.", polishing: false }));
    await hold(r, "and the slides");
    expect(r.typed).toEqual(["Send 25 copies to Maya by Friday.", " And the slides."]);
    expect(r.dictate.isOpen()).toBe(true);
    expect(r.ports.release).not.toHaveBeenCalled();
    // Undo goes, the session stays.
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(r.last()).toMatchObject({ undo: false });
  });

  it("throws away a tap's capture, so a stray tap types nothing and the session stays", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.say("half a word");
    await r.dictate.holdCancel();
    expect(r.typed).toEqual([]);
    expect(r.consumed).toEqual([true]);
    expect(r.last()).toMatchObject({ phase: "idle", partial: "" });
    expect(r.dictate.isOpen()).toBe(true);
  });

  it("says so when the words it heard could not be written down, or there were none, and types nothing", async () => {
    for (const [held, note] of [["lost", "Your words could not be written down."], ["silent", NO_SPEECH]] as const) {
      const r = rig({ held, inserted: "copied" });
      await hold(r, "");
      expect(r.typed).toEqual([]);
      expect(r.ports.typing).not.toHaveBeenCalled();
      expect(r.ports.copy).not.toHaveBeenCalled();
      expect(r.kept).toEqual([]);
      expect(r.last()).toMatchObject({ phase: "idle", partial: "", inserted: 0, note, undo: false });
      expect(r.dictate.isOpen()).toBe(true);
    }
  });

  it("copies what it could not type, and says so", async () => {
    const r = rig({ inserted: "copied" });
    await hold(r, "hello there friend");
    expect(r.last()).toMatchObject({ inserted: 0, note: "No text box in focus. Copied instead." });
  });

  it("keeps Undo for a paste that landed: the clipboard is put back afterwards and is no part of it", async () => {
    const r = rig();
    await hold(r, "send it friday");
    expect(r.ports.copy).not.toHaveBeenCalled();
    expect(r.last()).toMatchObject({ undo: true, note: "" });
  });

  it("offers no Undo for words that did not all land, and copies them", async () => {
    const r = rig({ ended: false });
    await hold(r, "send it friday");
    expect(r.ports.copy).toHaveBeenCalledWith("Send it Friday.");
    expect(r.last()).toMatchObject({ undo: false, note: "No text box in focus. Copied instead." });
  });

  it("a press while the last hold's words are still being typed hears its own words, typed after them", async () => {
    let answer = (_: string) => {};
    const r = rig({ voided: true, settings: { polish: { enabled: true, tone: "natural" } }, rewrite: async (ask) => (ask.text === "Second" ? "Second" : new Promise<string>((ok) => { answer = ok; })) });
    await r.dictate.setOpen(true);
    const first = hold(r, "first");
    await vi.advanceTimersByTimeAsync(0);
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    r.say("second");
    const second = r.dictate.holdEnd();
    answer("First.");
    await Promise.all([first, second]);
    expect(r.typed).toEqual(["First.", " Second"]);
  });

  it("is not moved by the engine's own listening and waiting while the key is down", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    r.dictate.holdStart();
    r.dictate.hearing(false);
    expect(r.last()?.phase).toBe("listening");
  });
});

describe("hands-free", () => {
  it("types each utterance, spaced after the first, until it is closed", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    expect(await utter(r, "first thing here")).toBe(true);
    expect(await utter(r, "second thing here")).toBe(true);
    expect(r.typed).toEqual(["First thing here.", " Second thing here."]);
    await r.dictate.setOpen(false);
    expect(await r.dictate.heard("not for dictate")).toBe(false);
  });

  it("types utterances in the order they were said, however slow the first polish", async () => {
    const answers: ((t: string) => void)[] = [];
    const r = rig({ settings: { polish: { enabled: true, tone: "natural" } }, rewrite: () => new Promise<string>((ok) => { answers.push(ok); }) });
    await r.dictate.setOpen(true);
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

  it("follows the engine between listening and waiting", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    r.dictate.hearing(true);
    expect(r.last()?.phase).toBe("listening");
    r.dictate.partial("so far");
    expect(r.last()?.partial).toBe("so far");
    r.dictate.hearing(false);
    expect(r.last()?.phase).toBe("idle");
  });
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
    await r.dictate.setOpen(true);
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

  /** A brain that streams `pieces`, then answers with them whole or fails with `error`. */
  const streaming = (r: ReturnType<typeof rig>, pieces: string[], error?: string) => {
    r.ports.rewrite = vi.fn(async (_ask: RewriteAsk, _s: AbortSignal, onText: (t: string) => void) => {
      for (const p of pieces) { onText(p); await vi.advanceTimersByTimeAsync(0); }
      if (error) throw new Error(error);
      return pieces.join("");
    });
  };

  it("types the rewrite as it streams in, in one insertion, counting the words on the orb", async () => {
    const r = rig({ settings: on });
    streaming(r, ["Please send", " it by Friday."]);
    const counts: number[] = [];
    r.ports.show = (d) => { if (d?.phase === "processing" && d.inserted) counts.push(d.inserted); };
    await hold(r, "send it by friday");
    expect(r.typed).toEqual(["Please send it by Friday."]);
    expect(r.ports.typing).toHaveBeenCalledTimes(1);
    expect(counts).toEqual([2, 5]);
    expect(r.kept).toMatchObject([{ final: "Please send it by Friday." }]);
  });

  it("keeps what it typed when the brain fails partway, and puts all of it on the clipboard", async () => {
    const r = rig({ settings: on });
    streaming(r, ["Please send"], "the connection dropped");
    await hold(r, "send it by friday");
    expect(r.typed).toEqual(["Please send"]);
    expect(r.ports.copy).toHaveBeenCalledWith("Send it by Friday.");
    expect(r.last()).toMatchObject({ inserted: 2, undo: true, note: "AI polish stopped partway. All of it is on the clipboard." });
  });

  it("offers no Undo when what it typed partway may not have landed", async () => {
    const r = rig({ settings: on, ended: false });
    streaming(r, ["Please send"], "the connection dropped");
    await hold(r, "send it by friday");
    expect(r.last()).toMatchObject({ undo: false, note: "AI polish stopped partway. All of it is on the clipboard." });
  });

  it("copies the whole rewrite where there is no text box to stream it into", async () => {
    const r = rig({ settings: on, inserted: "copied" });
    streaming(r, ["Please send", " it by Friday."]);
    await hold(r, "send it by friday");
    expect(r.ports.copy).toHaveBeenCalledWith("Please send it by Friday.");
    expect(r.last()?.note).toBe("No text box in focus. Copied instead.");
  });
});

describe("a rewrite's stream", () => {
  const body = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((t) => c.enqueue(new TextEncoder().encode(t))); c.close(); } });

  it("hands on each piece and resolves to the whole, however the lines are split", async () => {
    const got: string[] = [];
    expect(await readRewrite(body('{"delta":"Send"}\n{"del', 'ta":" it."}\n{"text":"Send it."}\n'), (t) => got.push(t))).toBe("Send it.");
    expect(got).toEqual(["Send", " it."]);
  });

  it("rejects on the brain's error, or a stream that ends without an answer", async () => {
    await expect(readRewrite(body('{"delta":"Se"}\n{"error":"rate limited"}\n'), () => {})).rejects.toThrow("rate limited");
    await expect(readRewrite(body('{"delta":"Se"}\n'), () => {})).rejects.toThrow(/without an answer/);
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
    await r.dictate.setOpen(true);
    await r.dictate.heard("first line");
    await r.dictate.heard("new paragraph");
    await r.dictate.heard("second line");
    expect(r.pressed).toEqual([[["shift", "enter"], 2]]);
    expect(r.typed).toEqual(["First line", "Second line"]);
  });

  it("takes back the last insertion with one Backspace per character, once", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    await r.dictate.heard("send it");
    await r.dictate.heard("and more 👍");
    await r.dictate.heard("undo that");
    expect(r.pressed).toEqual([[["backspace"], " And more 👍".length - 1]]);
    await r.dictate.heard("undo that");
    expect(r.pressed).toHaveLength(1);
    expect(r.last()?.note).toMatch(/Nothing/);
  });

  it("offers no Undo after a trailing command: Backspace from there would eat the line break, not the words", async () => {
    const r = rig();
    await hold(r, "Sounds good. Press enter.");
    expect(r.typed).toEqual(["Sounds good."]);
    expect(r.last()).toMatchObject({ undo: false, note: "Pressed Enter" });
  });

  it("offers Undo on the orb after an insertion, which takes it back once", async () => {
    const r = rig();
    await hold(r, "send it");
    expect(r.last()).toMatchObject({ inserted: 2, undo: true });
    await Promise.all([r.dictate.undo(), r.dictate.undo()]);
    expect(r.pressed).toEqual([[["backspace"], r.typed[0]!.length]]);
    expect(r.last()).toMatchObject({ undo: false, inserted: 0, note: "Took it back" });
    expect(r.dictate.isOpen()).toBe(true);
  });

  it("stops offering Undo after a few seconds, or once the next words start", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
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

  it("closes the session on \"stop dictating\", hands-free and in push to talk alike", async () => {
    const r = rig();
    await r.dictate.setOpen(true);
    await r.dictate.heard("that is all. stop dictating");
    expect(r.typed).toEqual(["That is all."]);
    expect(r.dictate.active()).toBe(false);
    // The microphone is let go at once: talk after the stop must not reach Flow.
    expect(r.ports.release).toHaveBeenCalledTimes(1);
    const held = rig();
    await hold(held, "stop dictating");
    expect(held.typed).toEqual([]);
    expect(held.dictate.isOpen()).toBe(false);
  });

  it("types the words in another language, where spoken commands are English only", async () => {
    const r = rig({ settings: { lang: "es" } });
    await hold(r, "press enter");
    expect(r.typed).toEqual(["Press enter"]);
    expect(r.pressed).toEqual([]);
  });
});

describe("editing a selection by voice", () => {
  it("edits a selection the words began on and that is still selected, with Dictate's brain, typed over it", async () => {
    const r = rig({ selection: ["hey can u send the numbers"], rewrite: async () => "Could you send the numbers?" });
    await r.dictate.setOpen(true);
    r.dictate.holdStart();
    await vi.advanceTimersByTimeAsync(0);
    // Said on the orb for the whole utterance, and the brain is woken for it.
    expect(r.last()).toMatchObject({ editing: true, phase: "listening" });
    expect(r.ports.warm).toHaveBeenCalled();
    r.say("um make it polite");
    await r.dictate.holdEnd();
    expect(r.asked).toEqual([{ kind: "command", text: "Make it polite.", selection: "hey can u send the numbers" }]);
    expect(r.typed).toEqual(["Could you send the numbers?"]);
    expect(r.kept).toEqual([{ raw: "um make it polite", cleaned: "Make it polite.", final: "Could you send the numbers?", command: true, copied: false }]);
    expect(r.last()).toMatchObject({ editing: false, phase: "idle", undo: true });
  });

  it("does the same hands-free, reading the selection once as the words begin, not again at a pause", async () => {
    const r = rig({ selection: ["draft one"], rewrite: async () => "Draft two" });
    await r.dictate.setOpen(true);
    r.dictate.speechStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.last()).toMatchObject({ editing: true });
    r.dictate.partial("make it");
    r.dictate.speechStart();
    await r.dictate.heard("make it the second draft");
    // Once as the words began, once more as they ended.
    expect(r.ports.selection).toHaveBeenCalledTimes(2);
    expect(r.typed).toEqual(["Draft two"]);
  });

  it("types normally when the selection changed or went before the words ended", async () => {
    for (const end of ["something else", ""]) {
      const r = rig({ selection: ["the old line", end] });
      await hold(r, "the new line");
      expect(r.asked).toEqual([]);
      expect(r.typed).toEqual(["The new line."]);
      expect(r.last()).toMatchObject({ editing: false, note: "" });
    }
  });

  it("types normally where the selection cannot be read that way, as on Wayland", async () => {
    const r = rig({ selection: [null] });
    await hold(r, "the new line");
    expect(r.asked).toEqual([]);
    expect(r.typed).toEqual(["The new line."]);
    expect(r.shown.some((d) => d?.editing)).toBe(false);
  });

  it("with no brain to edit with, never claims to edit: types over the selection and says so", async () => {
    const r = rig({ selection: ["the old line"], settings: { canEdit: false } });
    await hold(r, "the new line");
    expect(r.shown.some((d) => d?.editing)).toBe(false);
    expect(r.asked).toEqual([]);
    expect(r.typed).toEqual(["The new line."]);
    expect(r.last()?.note).toBe(NO_EDIT_BRAIN);
  });

  it("changes nothing when the brain fails or runs out of time", async () => {
    const r = rig({ selection: ["keep me"], rewrite: async () => { throw new Error("rate limited"); } });
    await hold(r, "make it formal");
    expect(r.typed).toEqual([]);
    expect(r.last()?.note).toBe("rate limited");
    const slow = rig({ selection: ["keep me"] });
    slow.ports.rewrite = vi.fn(() => new Promise<string>(() => {}));
    await slow.dictate.setOpen(true);
    slow.dictate.holdStart();
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
      const r = rig({ selection: [selection] });
      await hold(r, "make it formal");
      expect(r.asked).toEqual([]);
      expect(r.typed).toEqual([]);
      expect(r.last()).toMatchObject({ phase: "idle", note: "Selection too long to edit." });
    }
  });

  it("an edit after other words in the session is typed with no space before it", async () => {
    const r = rig({ selection: ["", "old"], rewrite: async () => "New" });
    await hold(r, "first words");
    await hold(r, "replace it");
    expect(r.typed).toEqual(["First words", "New"]);
  });
});
