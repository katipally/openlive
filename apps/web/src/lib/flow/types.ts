// What the orb shows and what it can ask the owner renderer to do. The orb is a
// display and command surface only: every decision in here was already made by
// the owner, which runs the cascade and the Flow socket.
//
// Flow is voice. What was said belongs in the transcript, not on a floating
// window, so this carries only what the orb actually draws: which way it is
// pulsing, and the one thing that needs the person.

export type FlowPhase = "idle" | "listening" | "thinking" | "speaking" | "acting" | "confirming" | "error";

/** Every way Flow can be unable to do its job. Each one gets one clear action. */
export type FlowFailureCode =
  | "no_provider"
  | "no_accessibility"
  | "secure_input"
  | "offline"
  | "models_missing"
  | "hook_failed"
  /** The ol-input addon did not load: not built in a checkout, damaged in an install. */
  | "addon_missing"
  | "mic_failed"
  | "answer_lost"
  /** The brain refused this turn for a reason that is fixed in settings. */
  | "brain_setup"
  /** The brain failed this turn, and nothing in OpenLive fixes it. */
  | "turn_failed";

export interface FlowFailure {
  code: FlowFailureCode;
  /** One sentence, in the user's words, about what just did not happen. */
  title: string;
  /** Why, and what is still true (their words are usually still recoverable). */
  detail: string;
  /** The single thing they can do about it. Absent when there is nothing to press. */
  actionLabel?: string;
  /** The settings page that action opens, when the fix lives in settings. */
  settings?: FlowSettingsPage;
}

/** The settings pages a failure's fix can live on. */
export type FlowSettingsPage = "models" | "flow" | "agents";

export interface FlowSnapshot {
  phase: FlowPhase;
  /** What Flow is saying back this turn. Kept because a barge-in has to report
   *  how much of it was actually voiced. */
  reply: string;
  /** Why Flow is in this phase, for the owner's own logic. */
  detail: string;
  /** Whether this turn is being spoken out loud, after auto-quiet. */
  speaking: boolean;
  /** The one thing worth growing the orb for, besides a question. */
  failure: FlowFailure | null;
  /** The last sentence the side talk check dropped, until the next turn: shown
   *  with "Send it". Empty when there is none. */
  aside: string;
  /** Dictate, while it has the orb. Null the rest of the time. */
  dictate: DictateSnapshot | null;
}

/** Dictate on the orb: Flow's orb in Dictate's colours, with what it heard. */
export interface DictateSnapshot {
  /** idle: hands-free and waiting for words. processing: cleaning up and typing. */
  phase: "idle" | "listening" | "processing";
  /** Open until stopped, rather than held by the key. */
  handsFree: boolean;
  /** The key as the person reads it, for the hold pill. */
  keys: string[];
  /** What it has heard so far this utterance. */
  partial: string;
  /** Words the last utterance typed, shown once it lands. */
  inserted: number;
  /** Why it typed nothing, or where the words went instead. */
  note: string;
}

export const IDLE_FLOW: FlowSnapshot = {
  phase: "idle", reply: "", detail: "", speaking: true, failure: null, aside: "", dictate: null,
};
