import { cleanup, countWords, type CleanupRules } from "./cleanup";
import { applyDictionary, snippetFor, spokenCommand, type Snippet, type SpokenCommand } from "./words";
import type { DictateSnapshot } from "@/lib/flow/types";
import type { HoldEnd } from "@/lib/live/voiceEngine";
import { DICTATE_BODY_MAX, DICTATE_TEXT_MAX } from "@openlive/shared";

// Dictate inside Flow's owner renderer: a session, opened and closed by its
// gesture, in which each finished utterance (a pause hands-free, a release in
// push to talk) is cleaned up on this machine and typed at the cursor. An
// utterance begun on a selection that is still selected when it ends is an
// instruction for that selection instead, for Dictate's brain. Plain dictation
// never reaches a brain and is never spoken back: the owner hands every
// utterance here first, and one Dictate takes is gone.
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
  words: readonly string[];
  snippets: readonly Snippet[];
  /** The spoken commands switched on. */
  commands: ReadonlySet<SpokenCommand>;
  polish: { enabled: boolean; tone: Tone };
  /** Dictate's brain is set up, so a selection can be edited by voice. */
  canEdit: boolean;
}

/** Typing at the cursor, open: words pushed as they come, then ended. */
export interface Typing {
  push(text: string): Promise<void>;
  /** False when the words did not all land. Putting the clipboard back after a
   *  paste is not part of it: ol-input does that later, on its own thread. */
  end(): Promise<boolean>;
}

export interface DictatePorts {
  /** Opens the microphone if it is not open. False when it could not be. */
  listen(): Promise<boolean>;
  /** The microphone and speech engine are up, so words are heard as they are said. */
  ready(): boolean;
  /** The push-to-talk key is down: every word until it is up is one utterance. */
  beginHold(): void;
  /** The key went up `lateMs` ago: the utterance is heard now, through `heard`, before
   *  this resolves, unless no words were heard ("silent") or they could not be written down ("lost"). */
  endHold(lateMs: number): Promise<HoldEnd>;
  /** The hold is given up and its words dropped, at once. */
  dropHold(): void;
  /** Typing at the cursor, opened. Null where nothing in focus takes typing. */
  typing(): Promise<Typing | null>;
  /** On the clipboard. False when it could not be. */
  copy(text: string): Promise<boolean>;
  /** What the orb shows, or null once Dictate gives it back. */
  show(d: DictateSnapshot | null): void;
  /** Dictate closed: nothing it caught from here on goes anywhere, and the microphone may close. */
  release(): void;
  /** One rewrite by Dictate's brain, its words handed to `onText` as they come.
   *  Resolves to the whole; rejects when it fails, or once `signal` aborts. */
  rewrite(ask: RewriteAsk, signal: AbortSignal, onText: (text: string) => void): Promise<string>;
  /** Starts the brain ahead of a rewrite, where starting one takes seconds. */
  warm(): void;
  /** The text selected in the app in front, through the accessibility API
   *  alone: "" for none, null where it cannot be read that way. */
  selection(): Promise<string | null>;
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
export const NO_SPEECH = "No words heard.";
export const COPIED = "No text box in focus. Copied instead.";
/** Flow's owner window records each dictation; this tells the main window to read the list again. */
export const HISTORY_CHANNEL = "openlive-dictate-history";
const FAILED = "That could not be typed or copied.";
const POLISH_LATE = "AI polish did not answer. Typed it as cleaned up.";
const POLISH_CUT = "AI polish stopped partway.";
const ON_CLIPBOARD = " All of it is on the clipboard.";
const COMMAND_FAILED = "No answer came back, so nothing changed.";
const NOTHING_TO_UNDO = "Nothing of mine to take back.";
const KEYS_FAILED = "That key could not be pressed.";
const TOO_LONG = "Selection too long to edit.";
/** A selection the words would have edited, with no brain to edit it. */
export const NO_EDIT_BRAIN = "Typed over the selection. Set up Dictate's AI to edit it by voice instead.";

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
  let open = false;
  // A push-to-talk hold is down: its words are one utterance, ended by the release.
  let holding = false;
  // The last text Dictate typed, which "undo that" takes back.
  let last: string | null = null;
  // The microphone opening for this session, which a hold waits on.
  let opening: Promise<boolean> = Promise.resolve(true);
  // A cancelled hold's capture: whatever it heard is thrown away.
  let discarding = false;
  // Each utterance after the first in a session is typed after a space.
  let typed = 0;
  // The selection this utterance began on: "" for none, or none readable.
  let began: Promise<string> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let offer: ReturnType<typeof setTimeout> | undefined;
  let d: DictateSnapshot | null = null;
  // Utterances are cleaned up and typed one after another, so a slow polish
  // never lets the next one land first.
  let work: Promise<unknown> = Promise.resolve();

  const set = (patch: Partial<DictateSnapshot>) => {
    // Gone from the orb: work still landing after a close does not bring it back.
    if (!open && !d) return;
    d = { phase: "idle", editing: false, partial: "", polishing: false, inserted: 0, note: "", undo: false, ready: true, ...d, ...patch };
    if (patch.undo) { clearTimeout(offer); offer = setTimeout(() => { if (d?.undo) set({ undo: false }); }, UNDO_MS); }
    ports.show(d);
  };
  const stopLinger = () => { if (linger) clearTimeout(linger); linger = null; };
  /** Closed. `linger`: what it last said stays up a moment first, for a
   *  session that could not start. Otherwise the person closed it, so the orb
   *  goes back straight away and the microphone with it. */
  const close = (lingers = false) => {
    // Left on, the engine would wait for a release that never comes.
    if (holding) ports.dropHold();
    open = false;
    holding = false;
    began = null;
    ports.release();
    stopLinger();
    if (!d) return;
    if (!lingers || !d.note) return giveBack();
    linger = setTimeout(giveBack, DONE_MS);
  };
  const giveBack = () => { stopLinger(); d = null; ports.show(null); };

  const start = (): Promise<boolean> => {
    stopLinger();
    open = true;
    typed = 0;
    began = null;
    d = null;
    set({ ready: ports.ready() });
    opening = ports.listen().then((ok) => {
      if (!open) return ok;
      if (!ok) { set({ note: NO_MIC }); close(true); }
      else if (!d?.ready) set({ ready: true });
      return ok;
    });
    return opening;
  };

  /** Opens or closes the session; what the tool that asked for it is told. */
  const setOpen = async (on: boolean): Promise<string> => {
    if (!on) {
      if (!open) return "Dictation was already off.";
      close();
      return "Dictation is off.";
    }
    if (open) return "Dictation is already on.";
    return (await start()) ? "Dictation is on. What the user says next is typed at their cursor." : NO_MIC;
  };

  /** Reads the selection an utterance begins on, and says on the orb when it
   *  is one the words will edit. */
  const look = () => {
    const read = ports.selection().then((s) => s ?? "", () => "");
    began = read;
    void read.then((s) => {
      if (!s || began !== read || !open || !ports.settings().canEdit) return;
      ports.warm();
      set({ editing: true });
    });
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
  /** A session's later words follow its earlier ones after a space. */
  const lead = () => (typed ? " " : "");
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
    // Undo takes back only words known to have landed.
    if (pushed && ended) landed("typed", space + sent);
    else { typed++; last = null; }
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
    const spoken = english ? spokenCommand(text, s.commands) : null;
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
    set({ phase: "idle", partial: "", polishing: false, editing: false, inserted: out === "typed" && last ? countWords(last) : 0, note: (out && insertedNote(out)) || note || obeyed, undo: last !== null });
    if (spoken?.command === "stop") close();
  };

  /** What was said, as an instruction for `selection`, typed over it. */
  const edit = async (text: string, selection: string, s: DictateSettings) => {
    const instruction = cleanup(text, s.rules, s.lang);
    if (!instruction) { set({ partial: "", editing: false }); return; }
    set({ phase: "processing", partial: instruction, editing: true });
    const ask = { kind: "command", text: instruction, selection } as const;
    if (selection.length > DICTATE_TEXT_MAX || new TextEncoder().encode(JSON.stringify(ask)).length > DICTATE_BODY_MAX) { set({ phase: "idle", partial: "", editing: false, note: TOO_LONG }); return; }
    let result: string;
    try { result = await think(ask, COMMAND_MS); }
    catch (e) { set({ phase: "idle", partial: "", editing: false, note: (e instanceof Error && e.message) || COMMAND_FAILED }); return; }
    // An edit is its own text, not the next words of a sentence: no space before it.
    const out = landed(await insert(result), result);
    if (out !== "failed") ports.record({ raw: text, cleaned: instruction, final: result, command: true, copied: out === "copied" });
    set({ phase: "idle", partial: "", editing: false, inserted: out === "typed" ? countWords(result) : 0, note: insertedNote(out), undo: last !== null });
  };

  /** Whether the utterance that began on `before` edits it: it was selected
   *  then, is still selected now, and there is a brain to edit with. Read at
   *  the utterance's end, before any earlier one still being typed lands. */
  const editsSelection = async (before: string): Promise<"edit" | "type" | "typeOver"> => {
    if (!before) return "type";
    const now = await ports.selection().then((s) => s ?? "", () => "");
    if (now !== before) return "type";
    return ports.settings().canEdit ? "edit" : "typeOver";
  };

  return {
    /** Dictate has the microphone, so an utterance is its to take. */
    active: () => open || discarding,
    isOpen: () => open,
    /** A hold, or the work of an utterance, is under way: silence does not close it. */
    busy: () => holding || d?.phase === "processing",
    /** The push-to-talk key went down. Only inside an open session. */
    holdStart() {
      if (!open || holding) return;
      holding = true;
      look();
      if (ports.settings().polish.enabled) ports.warm();
      set({ phase: "listening", partial: "", note: "", inserted: 0, undo: false, editing: false });
      void opening.then((ok) => { if (ok && holding) ports.beginHold(); });
    },
    async holdEnd() {
      if (!holding) return;
      const up = performance.now();
      if (!(await opening)) { holding = false; return; }
      set({ phase: "processing" });
      const ended = await ports.endHold(performance.now() - up);
      holding = false;
      if (!open) return;
      if (ended !== "heard") { began = null; set({ phase: "idle", partial: "", editing: false, note: ended === "lost" ? NOT_WRITTEN : NO_SPEECH }); }
      // The engine hands the words over without waiting for them to be typed.
      await work;
    },
    /** A tap, a key on top, or sleep: the hold's words go nowhere. */
    async holdCancel() {
      if (!holding) return;
      holding = false;
      began = null;
      if (await opening) {
        discarding = true;
        try { await ports.endHold(0); } finally { discarding = false; }
      }
      if (open) set({ phase: "idle", partial: "", editing: false });
    },
    /** Hands-free, the user started talking: an utterance begins here unless
     *  one is already under way, and the selection it begins on is read now. */
    speechStart() {
      if (open && !holding && (!began || !d?.partial)) look();
    },
    setOpen,
    /** The orb's Undo: "undo that", once, for as long as it is offered. */
    async undo() {
      if (!d?.undo) return;
      set({ undo: false });
      const run = work.then(async () => {
        const note = await obey("undo");
        if (d) set({ inserted: 0, note });
      });
      work = run.catch(() => {});
      await run;
    },
    /** Flow was opened, or the machine is going to sleep: Dictate stops now. */
    yield() {
      // Flow, opened mid-hold, ends its own turns: the hold is dropped as Dictate closes.
      if (!open && !d) return;
      if (open) close();
      else giveBack();
    },
    /** What the engine is hearing so far. */
    partial(text: string) {
      if (open && d?.phase !== "processing") set({ partial: text, inserted: 0, note: "", undo: false, phase: "listening" });
    },
    /** Hands-free, whether the engine hears speech right now or waits for it. */
    hearing(on: boolean) {
      if (open && !holding && d && d.phase !== "processing") set({ phase: on ? "listening" : "idle" });
    },
    /** A finished utterance. True when Dictate took it, so it must go nowhere else. */
    async heard(text: string): Promise<boolean> {
      if (discarding) return true;
      if (!open) return false;
      const s = ports.settings();
      const how = (began ?? Promise.resolve("")).then(async (before) => ({ before, as: await editsSelection(before) }));
      began = null;
      const run = work.then(async () => {
        const { before, as } = await how;
        if (as === "edit") return edit(text, before, s);
        if (as === "type" && d?.editing) set({ editing: false });
        await dictation(text, s);
        if (as === "typeOver" && d && !d.note) set({ note: NO_EDIT_BRAIN });
      });
      work = run.catch(() => {});
      await run;
      return true;
    },
  };
}

export type Dictate = ReturnType<typeof createDictate>;
