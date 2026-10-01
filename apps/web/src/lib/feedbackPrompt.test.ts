import { describe, expect, it } from "vitest";
import { hideAfter, REASONS, SCALE, step } from "./feedbackPrompt";
import { telemetrySchema } from "@openlive/shared";

const session = { kind: "session_rating", surface: "call" } as const;
const nps = { kind: "nps", surface: "main" } as const;

describe("the feedback prompt", () => {
  it("reports a thumbs up at once and says thanks", () => {
    expect(step("ask", { t: "up" })).toEqual({ phase: "thanks", answer: { outcome: "answered", rating: "up" } });
  });

  it("asks why after a thumbs down, and reports nothing until that is settled", () => {
    expect(step("ask", { t: "down" })).toEqual({ phase: "why" });
    expect(step("why", { t: "reason", reason: "too_slow" })).toEqual({ phase: "thanks", answer: { outcome: "answered", rating: "down", reason: "too_slow" } });
  });

  it("keeps a thumbs down when the follow-up is dismissed or left alone", () => {
    const down = { phase: null, answer: { outcome: "answered", rating: "down" } };
    expect(step("why", { t: "dismiss" })).toEqual(down);
    expect(step("why", { t: "leave" })).toEqual(down);
  });

  it("tells a dismissed prompt from an ignored one", () => {
    expect(step("ask", { t: "dismiss" })).toEqual({ phase: null, answer: { outcome: "dismissed" } });
    expect(step("ask", { t: "leave" })).toEqual({ phase: null, answer: { outcome: "ignored" } });
  });

  it("reports a score in one tap", () => {
    expect(step("ask", { t: "score", score: 0 })).toEqual({ phase: "thanks", answer: { outcome: "answered", score: 0 } });
    expect(step("ask", { t: "score", score: 10 }).answer).toEqual({ outcome: "answered", score: 10 });
  });

  it("reports don't ask again from either question", () => {
    for (const phase of ["ask", "why"] as const) expect(step(phase, { t: "never" })).toEqual({ phase: null, answer: { outcome: "never_again" } });
  });

  it("reports nothing more once it has said thanks", () => {
    for (const t of ["up", "dismiss", "leave", "never"] as const) expect(step("thanks", { t })).toEqual({ phase: null });
  });

  it("gives a scale longer to read than a thumb, and a follow-up less, all finite", () => {
    expect(hideAfter(nps, "ask")).toBeGreaterThan(hideAfter(session, "ask"));
    expect(hideAfter(session, "why")).toBeLessThan(hideAfter(session, "ask"));
    for (const o of [session, nps]) for (const p of ["ask", "why", "thanks"] as const) expect(hideAfter(o, p)).toBeGreaterThan(0);
  });

  it("offers exactly the reasons and scores the schema allows", () => {
    expect(REASONS.map((r) => r.id)).toEqual([...telemetrySchema.events.feedback_given.props.reason.values]);
    expect(SCALE).toEqual(Array.from({ length: telemetrySchema.events.feedback_given.props.score.max + 1 }, (_, i) => i));
  });
});
