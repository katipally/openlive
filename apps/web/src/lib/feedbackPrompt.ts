import type { FeedbackAnswer, FeedbackOffer, TelemetryEventProps } from "@openlive/shared";

// The feedback prompt as a pure state machine, so its rules can be tested
// without a window: what each tap reports, and when each step goes away by itself.

export type Reason = NonNullable<TelemetryEventProps<"feedback_given">["reason"]>;
/** `ask` is the question, `why` the one-tap follow-up after a thumbs down, `thanks` the closing word. */
export type Phase = "ask" | "why" | "thanks";
export type Action =
  | { t: "up" } | { t: "down" } | { t: "score"; score: number } | { t: "reason"; reason: Reason }
  | { t: "dismiss" } | { t: "never" }
  /** Nobody touched it: the time ran out, the window went away or something else needed the screen. */
  | { t: "leave" };

export const REASONS: readonly { id: Reason; label: string }[] = [
  { id: "wrong_answer", label: "Wrong answer" },
  { id: "too_slow", label: "Too slow" },
  { id: "misheard_me", label: "Misheard me" },
  { id: "didnt_do_it", label: "Didn't do it" },
  { id: "other", label: "Something else" },
];

export const SCALE = Array.from({ length: 11 }, (_, i) => i);

/** How long a step stays up untouched, in ms. A scale takes longer to read than a thumb. */
export const hideAfter = (offer: FeedbackOffer, phase: Phase): number =>
  phase === "thanks" ? 2_500 : phase === "why" ? 15_000 : offer.kind === "nps" ? 45_000 : 30_000;

/** What the tap does: the phase to show next (`null` closes the prompt) and the answer to report, if it is final. */
export function step(phase: Phase, action: Action): { phase: Phase | null; answer?: FeedbackAnswer } {
  if (phase === "thanks") return { phase: null };
  switch (action.t) {
    case "up": return { phase: "thanks", answer: { outcome: "answered", rating: "up" } };
    case "down": return { phase: "why" };
    case "score": return { phase: "thanks", answer: { outcome: "answered", score: action.score } };
    case "reason": return { phase: "thanks", answer: { outcome: "answered", rating: "down", reason: action.reason } };
    case "never": return { phase: null, answer: { outcome: "never_again" } };
    // A thumbs down already answered: leaving the follow-up keeps it.
    case "dismiss": return { phase: null, answer: phase === "why" ? { outcome: "answered", rating: "down" } : { outcome: "dismissed" } };
    case "leave": return { phase: null, answer: phase === "why" ? { outcome: "answered", rating: "down" } : { outcome: "ignored" } };
  }
}
