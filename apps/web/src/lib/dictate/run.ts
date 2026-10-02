import { cleanup, countWords, type CleanupRules } from "./cleanup";
import { applyDictionary, snippetFor, spokenCommand, type Snippet, type SpokenCommand } from "./words";
import type { DictateSnapshot } from "@/lib/flow/types";
import { DICTATE_BODY_MAX, DICTATE_TEXT_MAX } from "@openlive/shared";

// Dictate inside Flow's owner renderer: hold the key and talk, or go hands-free,
// and each finished utterance is cleaned up on this machine and typed at the
// cursor. It never reaches a brain and is never spoken back: the owner hands
// every utterance here first, and one Dictate takes is gone.
//
// Everything outside it arrives as a port, so the decisions are tested
// without a microphone, a socket or an orb.

export type Inserted = "typed" | "copied" | "failed";
export type Tone = "natural" | "casual" | "formal";
/** One rewrite by Dictate's brain, as /api/dictate/rewrite takes it. */
export type RewriteAsk = { kind: "polish"; text: string; tone: Tone } | { kind: "command"; text: string; selection: string };

export interface DictateSettings {
  rules: CleanupRules;
  lang: string;
  keys: string[];
  /** Command mode's key, for its Command badge. */
  commandKeys: string[];
  words: readonly string[];
  snippets: readonly Snippet[];
  /** The spoken commands switched on. */
  commands: ReadonlySet<SpokenCommand>;
  polish: { enabled: boolean; tone: Tone };
}

/** Typing at the cursor, open: words pushed as they come, then ended. */
export interface Typing {
  push(text: string): Promise<void>;
  /** False when the words did not all land. */
  end(): Promise<boolean>;
}

export interface DictatePorts {
  /** Opens the microphone if it is not open. False when it could not be.
   *  `hold`: a hold begins with it, so what is said while it opens is kept. */
  listen(hold: boolean): Promise<boolean>;
  /** The microphone and speech engine are up, so words are heard as they are said. */
  ready(): boolean;
  /** The key is down: every word until it is up is one utterance. */
  beginHold(): void;
  /** The key went up `lateMs` ago: the utterance is heard now, through `heard`, before
   *  this resolves. False when words were heard that could not be written down. */
  endHold(lateMs: number): Promise<boolean>;
  /** Typing at the cursor, opened. Null where nothing in focus takes typing. */
  typing(): Promise<Typing | null>;
  /** On the clipboard. False when it could not be. */
  copy(text: string): Promise<boolean>;
  /** Flow's turn in flight, if any, is let go: Dictate has the microphone now. */
  quietFlow(): void;
  /** What the orb shows, or null once Dictate gives it back. */
  show(d: DictateSnapshot | null): void;
  /** Dictate is done with the microphone: nothing it caught from here on goes anywhere. */
  release(): void;
  /** Hands-free opened or closed other than by the key, so the key's next tap does the right thing. */
  gestureOpen(open: boolean): void;
  /** One rewrite by Dictate's brain, its words handed to `onText` as they come.
   *  Resolves to the whole; rejects when it fails, or once `signal` aborts. */
  rewrite(ask: RewriteAsk, signal: AbortSignal, onText: (text: string) => void): Promise<string>;
  /** Starts the brain ahead of a rewrite, where starting one takes seconds. */
  warm(): void;
  /** The text selected in the app in front, "" when there is none. */
  selection(): Promise<string>;
  /** A key chord, its last key pressed `times` times. False when it could not be sent. */
  keys(keys: string[], times?: number): Promise<boolean>;
  /** Into History, where Settings keeps it. */
  record(d: { raw: string; cleaned: string; final: string; command?: boolean; copied?: boolean }): void;
  settings(): DictateSettings;
}

/** How long what was typed stays on the orb before it goes. */
export const DONE_MS = 1600;
/** How long the orb offers Undo after an insertion, and stays up for it. */
export const UNDO_MS = 5000;

const NO_MIC = "I could not open the microphone.";
const NOT_WRITTEN = "Your words could not be written down.";
const COPIED = "No text box in focus. Copied instead.";
const FAILED = "That could not be typed or copied.";
const POLISH_LATE = "AI polish did not answer. Typed it as cleaned up.";
const POLISH_CUT = "AI polish stopped partway.";
const ON_CLIPBOARD = " All of it is on the clipboard.";
const COMMAND_FAILED = "The brain did not answer, so nothing changed.";
const NOTHING_TO_UNDO = "Nothing of mine to take back.";
const KEYS_FAILED = "That key could not be pressed.";
const TOO_LONG = "Selection too long for a command.";

/** Past this the cleaned-up words go in as they are, so dictation is never lost to a slow brain. */
export const POLISH_MS = 25_000;
/** A command has nothing to fall back to, so it waits longer, as long as a coding agent may take to start. */
export const COMMAND_MS = 45_000;
/** As far back as "undo that" reaches, the most ol-input presses in one go. */
const UNDO_MAX = 2000;

const SAID: Record<SpokenCommand, string> = { enter: "Pressed Enter", newLine: "New line", newParagraph: "New paragraph", undo: "Took it back", stop: "" };
/** What Backspace takes one press each to remove: an emoji or an accented letter is one. */
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;

/** A rewrite as /api/dictate/rewrite streams it, one JSON object a line:
 *  `{ delta }` as the words come, then `{ text }` or `{ error }`. */
export async function readRewrite(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<string> {
  const reader = body.getReader();
  const utf8 = new TextDecoder();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The rewrite ended without an answer.");
    const lines = (rest + utf8.decode(value, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines.filter(Boolean)) {
      const line = JSON.parse(l) as { delta?: string; text?: string; error?: string };
      if (line.error) throw new Error(line.error);
      if (typeof line.text === "string") { void reader.cancel(); return line.text; }
      if (line.delta) onText(line.delta);
    }
  }
}

export function createDictate(ports: DictatePorts) {
  let mode: "hold" | "handsFree" | null = null;
  // The hold is command mode's: what is said is an instruction, not text.
  let commanding = false;
  // The last text Dictate typed, which "undo that" takes back.
  let last: string | null = null;
  // The mic opening for the press now in progress, which a quick release waits on.
  let opening: Promise<boolean> = Promise.resolve(true);
  // A tap's capture: whatever it heard is thrown away.
  let discarding = false;
  // Hands-free types each utterance after the one before, so all but the first are spaced.
  let typed = 0;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let offer: ReturnType<typeof setTimeout> | undefined;
  let d: DictateSnapshot | null = null;
  // Utterances are cleaned up and typed one after another, so a slow polish
  // never lets the next one land first.
  let work: Promise<unknown> = Promise.resolve();

  const set = (patch: Partial<DictateSnapshot>) => {
    d = { phase: "listening", handsFree: false, command: false, keys: ports.settings().keys, partial: "", polishing: false, inserted: 0, note: "", undo: false, ready: true, ...d, ...patch };
    if (patch.undo) { clearTimeout(offer); offer = setTimeout(() => { if (d?.undo) set({ undo: false }); }, UNDO_MS); }
    ports.show(d);
  };
  const stopLinger = () => { if (linger) clearTimeout(linger); linger = null; };
  /** Done: what it did stays up a moment, then the orb goes back. `now`: the
   *  person stopped it, so the orb goes back straight away. */
  const finish = (now = false) => {
    mode = null;
    ports.release();
    stopLinger();
    if (!d) return;
    if (now || (!d.inserted && !d.note)) return giveBack();
    // What lingers is not still hands-free: no Hands-free badge.
    if (d.handsFree) set({ handsFree: false });
    linger = setTimeout(giveBack, d.undo ? UNDO_MS : DONE_MS);
  };
  const giveBack = () => { stopLinger(); d = null; ports.show(null); };

  const start = (next: "hold" | "handsFree") => {
    stopLinger();
    mode = next;
    typed = 0;
    d = null;
    if (next === "handsFree") commanding = false;
    ports.quietFlow();
    const s = ports.settings();
    set({ handsFree: next === "handsFree", phase: next === "hold" ? "listening" : "idle", command: commanding, keys: commanding ? s.commandKeys : s.keys, ready: ports.ready() });
    opening = ports.listen(next === "hold").then((ok) => {
      if (mode !== next) return ok;
      if (!ok) { set({ note: NO_MIC }); finish(); }
      else if (!d?.ready) set({ ready: true });
      return ok;
    });
    return opening;
  };

  const setHandsFree = async (on: boolean, byKey: boolean): Promise<string> => {
    if (!byKey) ports.gestureOpen(on);
    if (!on) {
      if (mode !== "handsFree") return "Dictation was already off.";
      finish(true);
      return "Dictation is off.";
    }
    if (mode === "handsFree") return "Dictation is already on.";
    // The second tap of the double-tap was already capturing: that carries on.
    if (mode === "hold") { mode = "handsFree"; commanding = false; set({ handsFree: true, command: false, keys: ports.settings().keys }); await ports.endHold(0); return "Dictation is on."; }
    return (await start("handsFree")) ? "Dictation is on. What the user says next is typed at their cursor." : NO_MIC;
  };

  /** The brain's answer, or a rejection once `ms` pass, which also hangs up on it. */
  const think = async (ask: RewriteAsk, ms: number, onText: (text: string) => void = () => {}): Promise<string> => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error("")); }, ms); });
    try {
      const out = (await Promise.race([ports.rewrite(ask, ac.signal, onText), late])).trim();
      if (!out) throw new Error("");
      return out;
    } finally { clearTimeout(timer); }
  };

  /** At the cursor, or on the clipboard where there is no cursor to type at. */
  const insert = async (text: string): Promise<Inserted> => {
    const typing = await ports.typing();
    if (typing) {
      await typing.push(text);
      if (await typing.end()) return "typed";
    }
    return (await ports.copy(text)) ? "copied" : "failed";
  };
  /** Hands-free's later words follow its earlier ones after a space. */
  const lead = () => (mode === "handsFree" && typed ? " " : "");
  /** What landed, remembered for "undo that". */
  const landed = (out: Inserted, text: string): Inserted => {
    if (out !== "failed") typed++;
    last = out === "typed" ? text : null;
    return out;
  };
  const put = async (text: string): Promise<Inserted> => {
    const spaced = lead() + text;
    return landed(await insert(spaced), spaced);
  };

  /**
   * AI polish, typed as its words arrive. Before the first one lands a failure
   * types the cleaned-up words instead. After, what was typed stays, since
   * taking it back could hit whatever the app made of it, and all of the text
   * goes on the clipboard, so nothing said is lost.
   */
  const polish = async (clean: string, tone: Tone): Promise<{ final: string; out: Inserted; note: string }> => {
    const space = lead();
    set({ polishing: true });
    let opened = null as Promise<Typing | null> | null;
    let sent = "";
    let pushing = Promise.resolve();
    const onText = (text: string) => {
      opened ??= ports.typing();
      pushing = pushing.then(async () => {
        const typing = await opened;
        if (!typing) return;
        await typing.push((sent ? "" : space) + text);
        sent += text;
        set({ inserted: countWords(sent) });
      });
    };
    let answer: string | null = null;
    try { answer = await think({ kind: "polish", text: clean, tone }, POLISH_MS, onText); } catch { /* below */ }
    const pushed = await pushing.then(() => true, () => false);
    const typing = await opened;
    const ended = typing ? await typing.end() : false;
    if (!sent) {
      const final = answer ?? clean;
      return { final, out: await put(final), note: answer === null ? POLISH_LATE : "" };
    }
    if (answer === sent && pushed && ended) return { final: answer, out: landed("typed", space + sent), note: "" };
    const final = answer ?? clean;
    landed("typed", space + sent);
    return { final, out: "typed", note: POLISH_CUT + ((await ports.copy(final)) ? ON_CLIPBOARD : "") };
  };
  const insertedNote = (out: Inserted) => (out === "copied" ? COPIED : out === "failed" ? FAILED : "");

  /** A spoken command's keys. Its note, or "" when it said nothing. */
  const obey = async (c: SpokenCommand): Promise<string> => {
    if (c === "stop") return "";
    if (c === "undo") {
      const n = last ? graphemes(last) : 0;
      last = null;
      if (!n || n > UNDO_MAX) return NOTHING_TO_UNDO;
      return (await ports.keys(["backspace"], n)) ? SAID.undo : KEYS_FAILED;
    }
    // A new line is Shift+Enter, which breaks the line without sending in a chat box.
    const sent = c === "enter" ? await ports.keys(["enter"]) : await ports.keys(["shift", "enter"], c === "newParagraph" ? 2 : 1);
    // The next words start the line: no space before them.
    typed = 0;
    last = null;
    return sent ? SAID[c] : KEYS_FAILED;
  };

  const dictation = async (text: string, s: DictateSettings) => {
    const english = s.lang === "en";
    const on = mode === "handsFree" ? s.commands : new Set([...s.commands].filter((c) => c !== "stop"));
    const spoken = english ? spokenCommand(text, on) : null;
    const said = spoken ? spoken.before : text;
    const clean = applyDictionary(cleanup(said, s.rules, s.lang), s.words);
    if (!clean && !spoken) { set({ partial: "" }); return; }
    set({ phase: "processing", partial: clean });
    const snippet = snippetFor(clean, s.snippets);
    let final = snippet ?? clean;
    let note = "";
    let out: Inserted | null = null;
    if (final && !snippet && s.polish.enabled) ({ final, out, note } = await polish(clean, s.polish.tone));
    else if (final) out = await put(final);
    if (out && out !== "failed") ports.record({ raw: text, cleaned: clean, final, copied: out === "copied" });
    const obeyed = spoken ? await obey(spoken.command) : "";
    set({ phase: "idle", partial: "", polishing: false, inserted: out === "typed" && last ? countWords(last) : 0, note: (out && insertedNote(out)) || note || obeyed, undo: last !== null });
    if (spoken?.command === "stop") await setHandsFree(false, false);
  };

  const command = async (text: string, s: DictateSettings) => {
    const instruction = cleanup(text, s.rules, s.lang);
    if (!instruction) { set({ partial: "" }); return; }
    set({ phase: "processing", partial: instruction });
    const ask = { kind: "command", text: instruction, selection: await ports.selection() } as const;
    if (ask.selection.length > DICTATE_TEXT_MAX || new TextEncoder().encode(JSON.stringify(ask)).length > DICTATE_BODY_MAX) { set({ phase: "idle", partial: "", note: TOO_LONG }); return; }
    let result: string;
    try { result = await think(ask, COMMAND_MS); }
    catch (e) { set({ phase: "idle", partial: "", note: (e instanceof Error && e.message) || COMMAND_FAILED }); return; }
    // Typed over the selection, it replaces it.
    const out = await put(result);
    if (out !== "failed") ports.record({ raw: text, cleaned: instruction, final: result, command: true, copied: out === "copied" });
    set({ phase: "idle", partial: "", inserted: out === "typed" ? countWords(result) : 0, note: insertedNote(out), undo: last !== null });
  };

  return {
    /** Dictate has the microphone, so an utterance is its to take. */
    active: () => mode !== null || discarding,
    /** `command`: command mode's key, so what is said is an instruction for the selection. */
    holdStart(command = false) {
      if (mode === "handsFree") return;
      // Both keys down: the one with Shift is the one meant.
      if (mode === "hold") { if (command && !commanding) { commanding = true; set({ command: true, keys: ports.settings().commandKeys }); } return; }
      commanding = command;
      if (command || ports.settings().polish.enabled) ports.warm();
      void start("hold").then((ok) => { if (ok && mode === "hold") ports.beginHold(); });
    },
    async holdEnd() {
      if (mode !== "hold") return;
      const up = performance.now();
      if (!(await opening)) return;
      set({ phase: "processing" });
      const written = await ports.endHold(performance.now() - up);
      if (mode !== "hold") return;
      if (!written) set({ phase: "idle", partial: "", note: NOT_WRITTEN });
      // The engine hands the words over without waiting for them to be typed, so
      // the orb waits here; the key is free meanwhile for the next press.
      mode = null;
      await work;
      if (!mode) finish();
    },
    async holdCancel() {
      if (mode !== "hold") return;
      mode = null;
      if (await opening) {
        discarding = true;
        try { await ports.endHold(0); } finally { discarding = false; }
      }
      if (!mode) ports.release();
      giveBack();
    },
    setHandsFree,
    /** The orb's Undo: "undo that", once, for as long as it is offered. */
    async undo() {
      if (!d?.undo) return;
      set({ undo: false });
      const run = work.then(async () => {
        const note = await obey("undo");
        if (d) set({ inserted: 0, note });
        if (!mode) finish();
      });
      work = run.catch(() => {});
      await run;
    },
    /** The orb's mic button. */
    toggle: () => setHandsFree(mode !== "handsFree", false),
    /** Flow was opened over it: Flow wins the microphone and Dictate stops. */
    yield() {
      if (!mode && !d) return;
      if (mode === "handsFree") ports.gestureOpen(false);
      mode = null;
      giveBack();
    },
    /** What the engine is hearing so far. */
    partial(text: string) {
      if (mode && d?.phase !== "processing") set({ partial: text, inserted: 0, note: "", undo: false, phase: "listening" });
    },
    /** Hands-free, whether the engine hears speech right now or waits for it. */
    hearing(on: boolean) {
      if (mode === "handsFree" && d && d.phase !== "processing") set({ phase: on ? "listening" : "idle" });
    },
    /** A finished utterance. True when Dictate took it, so it must go nowhere else. */
    async heard(text: string): Promise<boolean> {
      if (discarding) return true;
      if (!mode) return false;
      const s = ports.settings();
      const asCommand = commanding;
      const run = work.then(() => (asCommand ? command(text, s) : dictation(text, s)));
      work = run.catch(() => {});
      await run;
      return true;
    },
  };
}

export type Dictate = ReturnType<typeof createDictate>;
