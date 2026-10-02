import { cleanup, type CleanupRules } from "./cleanup";
import type { DictateSnapshot } from "@/lib/flow/types";

// Dictate inside Flow's owner renderer: hold the key and talk, or go hands-free,
// and each finished utterance is cleaned up on this machine and typed at the
// cursor. It never reaches a brain and is never spoken back: the owner hands
// every utterance here first, and one Dictate takes is gone.
//
// Everything outside it arrives as a port, so the decisions are tested
// without a microphone, a socket or an orb.

export type Inserted = "typed" | "copied" | "failed";

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
  settings(): { rules: CleanupRules; lang: string; keys: string[] };
}

/** How long what was typed stays on the orb before it goes. */
export const DONE_MS = 1600;

const NO_MIC = "I could not open the microphone.";
const COPIED = "No text box in focus. Copied instead.";
const FAILED = "That could not be typed or copied.";

export function createDictate(ports: DictatePorts) {
  let mode: "hold" | "handsFree" | null = null;
  // The mic opening for the press now in progress, which a quick release waits on.
  let opening: Promise<boolean> = Promise.resolve(true);
  // A tap's capture: whatever it heard is thrown away.
  let discarding = false;
  // Hands-free types each utterance after the one before, so all but the first are spaced.
  let typed = 0;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let d: DictateSnapshot | null = null;

  const set = (patch: Partial<DictateSnapshot>) => {
    d = { phase: "listening", handsFree: false, keys: ports.settings().keys, partial: "", inserted: 0, note: "", ...d, ...patch };
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
    ports.quietFlow();
    set({ handsFree: next === "handsFree", phase: next === "hold" ? "listening" : "idle" });
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
    if (mode === "hold") { mode = "handsFree"; set({ handsFree: true }); await ports.endHold(); return "Dictation is on."; }
    return (await start("handsFree")) ? "Dictation is on. What the user says next is typed at their cursor." : NO_MIC;
  };

  return {
    /** Dictate has the microphone, so an utterance is its to take. */
    active: () => mode !== null || discarding,
    holdStart() {
      if (mode === "handsFree") return;
      void start("hold").then((ok) => { if (ok && mode === "hold") ports.beginHold(); });
    },
    async holdEnd() {
      if (mode !== "hold") return;
      if (!(await opening)) return;
      set({ phase: "processing" });
      await ports.endHold();
      if (mode === "hold") finish();
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
      const { rules, lang } = ports.settings();
      const clean = cleanup(text, rules, lang);
      if (!clean) { set({ partial: "" }); return true; }
      set({ phase: "processing", partial: "" });
      const out = await ports.insert(mode === "handsFree" && typed ? ` ${clean}` : clean);
      if (out !== "failed") typed++;
      const words = clean.split(/\s+/).length;
      set({ phase: "idle", inserted: out === "typed" ? words : 0, note: out === "copied" ? COPIED : out === "failed" ? FAILED : "" });
      return true;
    },
  };
}

export type Dictate = ReturnType<typeof createDictate>;
