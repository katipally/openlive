import { cleanup, type CleanupRules } from "./cleanup";
import { applyDictionary, snippetFor, spokenCommand, type Snippet, type SpokenCommand } from "./words";
import type { DictateSnapshot } from "@/lib/flow/types";

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
  /** Command mode's key, for its hold pill. */
  commandKeys: string[];
  words: readonly string[];
  snippets: readonly Snippet[];
  /** The spoken commands switched on. */
  commands: ReadonlySet<SpokenCommand>;
  polish: { enabled: boolean; tone: Tone };
}

export interface DictatePorts {
  /** Opens the microphone if it is not open. False when it could not be. */
  listen(): Promise<boolean>;
  /** The key is down: every word until it is up is one utterance. */
  beginHold(): void;
  /** The key is up: the utterance is heard now, through `heard`, before this resolves. */
  endHold(): Promise<void>;
  /** The words at the cursor, or on the clipboard where there is no cursor to type at. */
  insert(text: string): Promise<Inserted>;
  /** Flow's turn in flight, if any, is let go: Dictate has the microphone now. */
  quietFlow(): void;
  /** What the orb shows, or null once Dictate gives it back. */
  show(d: DictateSnapshot | null): void;
  /** Hands-free opened or closed other than by the key, so the key's next tap does the right thing. */
  gestureOpen(open: boolean): void;
  /** One rewrite by Dictate's brain. Rejects when it fails, or once `signal` aborts. */
  rewrite(ask: RewriteAsk, signal: AbortSignal): Promise<string>;
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

const NO_MIC = "I could not open the microphone.";
const COPIED = "No text box in focus. Copied instead.";
const FAILED = "That could not be typed or copied.";
const POLISH_LATE = "AI polish did not answer. Typed it as cleaned up.";
const COMMAND_FAILED = "The brain did not answer, so nothing changed.";
const NOTHING_TO_UNDO = "Nothing of mine to take back.";
const KEYS_FAILED = "That key could not be pressed.";

/** Past this the cleaned-up words go in as they are, so dictation is never lost to a slow brain. */
export const POLISH_MS = 15_000;
/** A command has nothing to fall back to, so it waits longer, as long as a coding agent may take to start. */
export const COMMAND_MS = 45_000;
/** As far back as "undo that" reaches, the most ol-input presses in one go. */
const UNDO_MAX = 2000;

const SAID: Record<SpokenCommand, string> = { enter: "Pressed Enter", newLine: "New line", newParagraph: "New paragraph", undo: "Took it back", stop: "" };
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** What Backspace takes one press each to remove: an emoji or an accented letter is one. */
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;

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
  let d: DictateSnapshot | null = null;
  // Utterances are cleaned up and typed one after another, so a slow polish
  // never lets the next one land first.
  let work: Promise<unknown> = Promise.resolve();

  const set = (patch: Partial<DictateSnapshot>) => {
    d = { phase: "listening", handsFree: false, command: false, keys: ports.settings().keys, partial: "", inserted: 0, note: "", ...d, ...patch };
    ports.show(d);
  };
  const stopLinger = () => { if (linger) clearTimeout(linger); linger = null; };
  /** Done: what it did stays up a moment, then the orb goes back. */
  const finish = () => {
    mode = null;
    stopLinger();
    if (!d) return;
    if (!d.inserted && !d.note) return giveBack();
    linger = setTimeout(giveBack, DONE_MS);
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
    set({ handsFree: next === "handsFree", phase: next === "hold" ? "listening" : "idle", command: commanding, keys: commanding ? s.commandKeys : s.keys });
    opening = ports.listen().then((ok) => {
      if (!ok && mode === next) { set({ note: NO_MIC }); finish(); }
      return ok;
    });
    return opening;
  };

  const setHandsFree = async (on: boolean, byKey: boolean): Promise<string> => {
    if (!byKey) ports.gestureOpen(on);
    if (!on) {
      if (mode !== "handsFree") return "Dictation was already off.";
      finish();
      return "Dictation is off.";
    }
    if (mode === "handsFree") return "Dictation is already on.";
    // The second tap of the double-tap was already capturing: that carries on.
    if (mode === "hold") { mode = "handsFree"; commanding = false; set({ handsFree: true, command: false, keys: ports.settings().keys }); await ports.endHold(); return "Dictation is on."; }
    return (await start("handsFree")) ? "Dictation is on. What the user says next is typed at their cursor." : NO_MIC;
  };

  /** The brain's answer, or a rejection once `ms` pass, which also hangs up on it. */
  const think = async (ask: RewriteAsk, ms: number): Promise<string> => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error("")); }, ms); });
    try {
      const out = (await Promise.race([ports.rewrite(ask, ac.signal), late])).trim();
      if (!out) throw new Error("");
      return out;
    } finally { clearTimeout(timer); }
  };

  /** Typed, with a space after hands-free's earlier words; remembered for "undo that". */
  const put = async (text: string): Promise<Inserted> => {
    const lead = mode === "handsFree" && typed ? " " : "";
    const out = await ports.insert(lead + text);
    if (out !== "failed") typed++;
    last = out === "typed" ? lead + text : null;
    return out;
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
    const english = s.lang === "auto" || s.lang.startsWith("en");
    const on = mode === "handsFree" ? s.commands : new Set([...s.commands].filter((c) => c !== "stop"));
    const spoken = english ? spokenCommand(text, on) : null;
    const said = spoken ? spoken.before : text;
    const clean = applyDictionary(cleanup(said, s.rules, s.lang), s.words);
    if (!clean && !spoken) { set({ partial: "" }); return; }
    set({ phase: "processing", partial: "" });
    const snippet = snippetFor(clean, s.snippets);
    let final = snippet ?? clean;
    let note = "";
    if (final && !snippet && s.polish.enabled) {
      try { final = await think({ kind: "polish", text: clean, tone: s.polish.tone }, POLISH_MS); }
      catch { note = POLISH_LATE; }
    }
    const out = final ? await put(final) : null;
    if (out && out !== "failed") ports.record({ raw: text, cleaned: clean, final, copied: out === "copied" });
    const obeyed = spoken ? await obey(spoken.command) : "";
    set({ phase: "idle", inserted: out === "typed" ? countWords(final) : 0, note: (out && insertedNote(out)) || note || obeyed });
    if (spoken?.command === "stop") await setHandsFree(false, false);
  };

  const command = async (text: string, s: DictateSettings) => {
    const instruction = cleanup(text, s.rules, s.lang);
    if (!instruction) { set({ partial: "" }); return; }
    set({ phase: "processing", partial: "" });
    const selection = await ports.selection();
    let result: string;
    try { result = await think({ kind: "command", text: instruction, selection }, COMMAND_MS); }
    catch (e) { set({ phase: "idle", note: (e instanceof Error && e.message) || COMMAND_FAILED }); return; }
    // Typed over the selection, it replaces it.
    const out = await put(result);
    if (out !== "failed") ports.record({ raw: text, cleaned: instruction, final: result, command: true, copied: out === "copied" });
    set({ phase: "idle", inserted: out === "typed" ? countWords(result) : 0, note: insertedNote(out) });
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
      if (!(await opening)) return;
      set({ phase: "processing" });
      await ports.endHold();
      if (mode !== "hold") return;
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
        try { await ports.endHold(); } finally { discarding = false; }
      }
      giveBack();
    },
    setHandsFree,
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
      if (mode && d?.phase !== "processing") set({ partial: text, inserted: 0, note: "", phase: "listening" });
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
