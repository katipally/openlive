// What the pill shows and what it can ask the owner renderer to do. The pill is
// a display and command surface only: every decision in here was already made by
// the owner, which runs the cascade and the Flow socket.

export type FlowPhase = "idle" | "listening" | "thinking" | "speaking" | "acting" | "confirming" | "error";

/** Every way Flow can be unable to do its job. Each one gets one clear action. */
export type FlowFailureCode =
  | "no_provider"
  | "no_accessibility"
  | "secure_input"
  | "wayland"
  | "offline"
  | "models_missing"
  | "hook_failed"
  | "listen_timeout";

export interface FlowFailure {
  code: FlowFailureCode;
  /** One sentence, in the user's words, about what just did not happen. */
  title: string;
  /** Why, and what is still true (their words are usually still recoverable). */
  detail: string;
  /** The single thing they can do about it. Absent when there is nothing to press. */
  actionLabel?: string;
}

/** Why Flow answered in text instead of out loud this turn. "" means it spoke. */
export type QuietReason = "" | "meeting" | "mic_busy" | "dnd" | "output_muted" | "off";

export interface FlowSnapshot {
  phase: FlowPhase;
  /** The binding, formatted, so the summon state can show what is being held. */
  binding: string;
  /** What the user is saying. `partial` greys it while the transcript is interim. */
  transcript: string;
  partial: boolean;
  /** What Flow is saying back this turn, spoken or written. */
  reply: string;
  /** The one-line "Reading the terminal output" cue under the heading. */
  detail: string;
  /** Text landing in the user's app right now, and the app it is landing in. */
  inserting: { text: string; app: string } | null;
  /** Whether this turn is being spoken. The manual override has already won here. */
  speaking: boolean;
  quiet: QuietReason;
  /** 0..1 while the voice models are still loading, else null. */
  warming: number | null;
  failure: FlowFailure | null;
}

export const IDLE_FLOW: FlowSnapshot = {
  phase: "idle", binding: "", transcript: "", partial: false, reply: "", detail: "",
  inserting: null, speaking: true, quiet: "", warming: null, failure: null,
};
