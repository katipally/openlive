import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { answer, DAY_1, fact, notice, rig } from "./rig";

const require = createRequire(import.meta.url);
const { wait } = require("./feedback.cjs");
const { validateEvent } = require("./validate.cjs");
const { localDay } = require("./state.cjs");
const schema = require("./schema.json");

const DAY = 86_400_000;
const caps = schema.feedback;
const T0 = DAY_1.getTime();

beforeEach(() => vi.useFakeTimers({ now: DAY_1 }));
afterEach(() => vi.useRealTimers());

const prompts = (over = {}) => ({ never: false, lastAt: 0, lastDay: "", lastSessionAt: 0, lastNpsAt: 0, ignoredInARow: 0, backoffUntil: 0, activeDays: 0, lastActiveDay: "", activated: false, ...over });
const ask = (over: Record<string, unknown>, kind: string, now: number, firstOpenAt: number | null = T0 - 30 * DAY) =>
  wait({ p: prompts(over), caps, now, firstOpenAt, kind });

describe("the caps, as a pure function of the clock", () => {
  it("lets a session rating through once the install is old enough and nothing recent stands in the way", () => {
    expect(ask({}, "session_rating", T0)).toBe("");
  });

  it("waits two days after the first open", () => {
    expect(ask({}, "session_rating", T0, T0 - 2 * DAY + 1)).toBe("new_install");
    expect(ask({}, "session_rating", T0, T0 - 2 * DAY)).toBe("");
    expect(ask({}, "session_rating", T0, null)).toBe("new_install");
  });

  it("allows one prompt of any kind in seven days, and a rating once in seven", () => {
    expect(ask({ lastAt: T0 - 7 * DAY + 1 }, "session_rating", T0)).toBe("recent_prompt");
    expect(ask({ lastAt: T0 - 7 * DAY + 1 }, "nps", T0, T0 - 400 * DAY)).toBe("recent_prompt");
    expect(ask({ lastAt: T0 - 7 * DAY }, "session_rating", T0)).toBe("");
    expect(ask({ lastSessionAt: T0 - 7 * DAY + 1 }, "session_rating", T0)).toBe("recent_rating");
  });

  it("never asks twice on one local day, whatever the other gaps say", () => {
    expect(wait({ p: prompts({ lastAt: T0 - 1000, lastDay: localDay(T0) }), caps: { ...caps, minDaysBetweenPrompts: 0 }, now: T0, firstOpenAt: T0 - 30 * DAY, kind: "session_rating" })).toBe("same_day");
  });

  it("asks the 0 to 10 question only of an activated install with seven active days, then at most every 90 days", () => {
    const ok = { activated: true, activeDays: 7 };
    expect(ask({ activeDays: 7 }, "nps", T0)).toBe("not_active_enough");
    expect(ask({ activated: true, activeDays: 6 }, "nps", T0)).toBe("not_active_enough");
    expect(ask(ok, "nps", T0)).toBe("");
    expect(ask({ ...ok, lastNpsAt: T0 - 90 * DAY + 1, lastAt: T0 - 30 * DAY }, "nps", T0)).toBe("recent_nps");
    expect(ask({ ...ok, lastNpsAt: T0 - 90 * DAY, lastAt: T0 - 90 * DAY }, "nps", T0)).toBe("");
  });

  it("backs off, and honors never", () => {
    expect(ask({ backoffUntil: T0 + 1 }, "session_rating", T0)).toBe("backoff");
    expect(ask({ backoffUntil: T0 }, "session_rating", T0)).toBe("");
    expect(ask({ never: true }, "nps", T0)).toBe("never");
  });
});

/** An install that has shown the notice, at `T0` plus `days`. */
function installed() {
  const r = rig();
  r.telemetry.start({ launchKind: "manual" });
  notice(r.telemetry);
  const on = (days: number) => vi.setSystemTime(T0 + days * DAY);
  /** A finished session with `turns` turns, `errors` of them failed. */
  const session = (surface: "flow" | "call", turns = 3, errors = 0) => {
    const [open, scope, close] = surface === "flow" ? (["openFlow", "agent_flow", "closeFlow"] as const) : (["openCall", "agent_call", "closeCall"] as const);
    r.telemetry[open]();
    fact(r.telemetry, scope, { turns, errors, brain_kind: "api", brain_id: "anthropic" });
    r.telemetry[close](surface === "flow" ? "gesture" : "end_button");
    vi.advanceTimersByTime(2100);
  };
  const feedback = () => r.queue().filter((q) => q.n === "feedback_given").map((q) => q.p);
  return { r, t: r.telemetry, on, session, feedback };
}

describe("session ratings", () => {
  it("are not offered in the first two days, then are, for a session with two answered turns", () => {
    const { t, on, session } = installed();
    on(1);
    session("call");
    expect(t.feedbackNext()).toBeNull();
    on(2);
    session("call");
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
  });

  it("need two answered turns, not two attempted", () => {
    const { t, on, session } = installed();
    on(3);
    session("flow", 3, 2);
    expect(t.feedbackNext()).toBeNull();
    session("flow", 2, 0);
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "flow" });
  });

  it("are never offered during a session, and only for the session that just ended", () => {
    const { t, on, session } = installed();
    on(3);
    t.openFlow();
    fact(t, "agent_flow", { turns: 5 });
    expect(t.feedbackNext()).toBeNull();
    t.closeFlow("gesture");
    vi.advanceTimersByTime(2100);
    on(3.3);
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "flow" });
    answer(t, { outcome: "dismissed" });
    on(5);
    session("call");
    on(5.3);
    expect(t.feedbackNext()).toBeNull();
    on(11);
    expect(t.feedbackNext()).toBeNull();
  });

  it("go stale after twelve hours", () => {
    const { t, on, session } = installed();
    on(3);
    session("call");
    on(3.6);
    expect(t.feedbackNext()).toBeNull();
  });

  it("report a thumbs up with the session's brain and a turns bucket", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("call", 4);
    t.feedbackNext();
    answer(t, { outcome: "answered", rating: "up" });
    expect(feedback()).toEqual([expect.objectContaining({ surface: "call", kind: "session_rating", outcome: "answered", rating: "up", brain_kind: "api", brain_id: "anthropic", turns_bucket: "3_5" })]);
  });

  it("report a thumbs down with its reason, and drop a reason that comes with a thumbs up", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("flow", 12);
    t.feedbackNext();
    answer(t, { outcome: "answered", rating: "down", reason: "too_slow" });
    on(11);
    session("flow", 2);
    t.feedbackNext();
    answer(t, { outcome: "answered", rating: "up", reason: "too_slow" });
    expect(feedback().map((p) => [p.rating, p.reason, p.turns_bucket])).toEqual([["down", "too_slow", "11_plus"], ["up", undefined, "2"]]);
  });

  it("count an answer with no rating as dismissed, and an unknown outcome too", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "answered" });
    on(11);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "sure" as never, rating: "up" });
    expect(feedback().map((p) => [p.outcome, p.rating])).toEqual([["dismissed", undefined], ["dismissed", undefined]]);
  });
});

describe("the 0 to 10 question", () => {
  /** An install that was used on eight days and activated on the way. */
  function seasoned() {
    const x = installed();
    x.t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "event", name: "onboarding_step", props: { step: "activated" } });
    for (let d = 0; d < 8; d++) {
      x.on(d);
      x.t.markActiveDay("main_window");
    }
    return x;
  }

  it("is offered on the main window to a used and activated install", () => {
    const { t, feedback } = seasoned();
    expect(t.feedbackNext()).toEqual({ kind: "nps", surface: "main" });
    answer(t, { outcome: "answered", score: 9 });
    expect(feedback()).toEqual([expect.objectContaining({ surface: "main", kind: "nps", outcome: "answered", score: 9 })]);
  });

  it("is not offered before seven active days or before activation", () => {
    const fresh = installed();
    for (let d = 2; d < 12; d++) fresh.on(d);
    expect(fresh.t.feedbackNext()).toBeNull();
    vi.setSystemTime(T0);
    const x = installed();
    for (let d = 0; d < 6; d++) {
      x.on(d);
      x.t.markActiveDay("main_window");
    }
    x.t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "event", name: "onboarding_step", props: { step: "activated" } });
    x.on(6);
    expect(x.t.feedbackNext()).toBeNull();
    x.t.markActiveDay("main_window");
    x.on(7);
    x.t.markActiveDay("main_window");
    expect(x.t.feedbackNext()).toEqual({ kind: "nps", surface: "main" });
  });

  it("comes back at most every 90 days, and a score outside 0 to 10 is dropped", () => {
    const { t, on, feedback } = seasoned();
    t.feedbackNext();
    answer(t, { outcome: "answered", score: 11 });
    expect(feedback().map((p) => p.outcome)).toEqual(["dismissed"]);
    on(7 + 89);
    expect(t.feedbackNext()).toBeNull();
    on(7 + 91);
    expect(t.feedbackNext()).toEqual({ kind: "nps", surface: "main" });
  });
});

describe("backing off, and saying no", () => {
  it("waits 30 days after two prompts in a row nobody answered, and a real answer clears the count", () => {
    const { t, on, session } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "ignored" });
    on(11);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "dismissed" });
    on(11 + 29);
    session("call");
    expect(t.feedbackNext()).toBeNull();
    on(11 + 30);
    session("call");
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
    answer(t, { outcome: "answered", rating: "up" });
    on(11 + 38);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "ignored" });
    on(11 + 46);
    session("call");
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
  });

  it("honors don't ask again for good, reports it once, and lets Settings turn prompts back on", () => {
    const { r, t, on, session, feedback } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "never_again" });
    expect(feedback().map((p) => p.outcome)).toEqual(["never_again"]);
    expect(t.getStatus().feedback).toBe(false);
    on(400);
    session("call");
    expect(t.feedbackNext()).toBeNull();
    const again = r.again();
    again.telemetry.start({ launchKind: "manual" });
    expect(again.telemetry.getStatus().feedback).toBe(false);
    again.telemetry.setFeedback(true);
    expect(again.telemetry.getStatus().feedback).toBe(true);
  });

  it("counts a prompt left up at quit as ignored", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    t.onQuit("tray_menu");
    expect(feedback().map((p) => p.outcome)).toEqual(["ignored"]);
  });

  it("frees a prompt its page never answered after ten minutes, counted as ignored", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    vi.advanceTimersByTime(60_000);
    expect(t.feedbackNext()).toBeNull();
    vi.advanceTimersByTime(600_000);
    t.feedbackNext();
    expect(feedback().map((p) => p.outcome)).toEqual(["ignored"]);
  });

  it("sends at most one feedback event a day", () => {
    expect(schema.events.feedback_given.limit).toEqual({ perDay: 1 });
  });
});

describe("a clock that was wrong", () => {
  it("does not mute prompts for as long as it was off: a time in the future becomes now", () => {
    const { t, on, session } = installed();
    on(400);
    session("call");
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
    answer(t, { outcome: "answered", rating: "up" });
    on(8);
    session("call");
    expect(t.feedbackNext()).toBeNull();
    on(14.9);
    session("call");
    expect(t.feedbackNext()).toBeNull();
    on(15.1);
    session("call");
    expect(t.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
  });

  it("cuts a back-off from the future down to its own length", () => {
    const { r, t, on, session } = installed();
    on(3);
    for (const n of [1, 2]) {
      session("call");
      t.feedbackNext();
      answer(t, { outcome: "dismissed" });
      on(3 + n * 8);
    }
    vi.advanceTimersByTime(2000);
    expect(r.state().prompts.backoffUntil).toBeGreaterThan(T0 + 30 * DAY);
    on(3);
    t.feedbackNext();
    vi.advanceTimersByTime(2000);
    expect(r.state().prompts.backoffUntil).toBeLessThanOrEqual(T0 + 33 * DAY);
  });
});

describe("silence", () => {
  it("asks nothing before the notice was shown, or once sharing is off, and sends nothing for what was open", () => {
    const r = rig();
    r.telemetry.start({ launchKind: "manual" });
    vi.setSystemTime(T0 + 3 * DAY);
    r.telemetry.openCall();
    fact(r.telemetry, "agent_call", { turns: 4 });
    r.telemetry.closeCall("end_button");
    vi.advanceTimersByTime(2100);
    expect(r.telemetry.feedbackNext()).toBeNull();
    notice(r.telemetry);
    expect(r.telemetry.feedbackNext()).toEqual({ kind: "session_rating", surface: "call" });
    void r.telemetry.setEnabled(false, "settings");
    answer(r.telemetry, { outcome: "answered", rating: "down", reason: "other" });
    expect(r.queue().map((q) => q.n)).not.toContain("feedback_given");
    expect(r.telemetry.feedbackNext()).toBeNull();
  });

  it("is inert in a build that never reports", () => {
    const t = rig({ isPackaged: false }).telemetry;
    expect(t.feedbackNext()).toBeNull();
    expect(() => { answer(t, { outcome: "ignored" }); t.setFeedback(false); }).not.toThrow();
    expect(t.getStatus().feedback).toBe(false);
  });

  it("keeps what it remembers across a restart", () => {
    const { r, t, on, session } = installed();
    on(3);
    session("call");
    t.feedbackNext();
    answer(t, { outcome: "answered", rating: "up" });
    t.onQuit("tray_menu");
    const again = r.again();
    again.telemetry.start({ launchKind: "manual" });
    vi.setSystemTime(T0 + 4 * DAY);
    again.telemetry.openCall();
    fact(again.telemetry, "agent_call", { turns: 4 });
    again.telemetry.closeCall("end_button");
    vi.advanceTimersByTime(2100);
    expect(again.telemetry.feedbackNext()).toBeNull();
  });

  it("does not let a page name the kind, the surface or the event", () => {
    const { t, on, session, feedback } = installed();
    on(3);
    session("call");
    t.handleRendererMessage({ t: "track", name: "feedback_given", props: { surface: "main", kind: "nps", outcome: "answered", score: 10 } });
    t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "event", name: "feedback_given", props: { surface: "main", kind: "nps", outcome: "answered", score: 10 } });
    t.feedbackNext();
    t.handleRendererMessage({ t: "feedback", outcome: "answered", rating: "up", kind: "nps", surface: "main", score: 10 });
    expect(feedback()).toEqual([expect.objectContaining({ surface: "call", kind: "session_rating", rating: "up" })]);
    expect(feedback()[0]).not.toHaveProperty("score");
  });
});

describe("feedback_given is valid only as a coherent answer", () => {
  const ok = { surface: "call", kind: "session_rating", outcome: "answered", rating: "down", reason: "too_slow" };
  it("keeps the shapes the prompts produce", () => {
    expect(validateEvent("feedback_given", ok)).toEqual(ok);
    expect(validateEvent("feedback_given", { surface: "main", kind: "nps", outcome: "answered", score: 0 })).toBeTruthy();
    expect(validateEvent("feedback_given", { surface: "flow", kind: "session_rating", outcome: "ignored" })).toBeTruthy();
    expect(validateEvent("feedback_given", { surface: "main", kind: "nps", outcome: "never_again" })).toBeTruthy();
  });

  it("drops the ones that contradict themselves", () => {
    const bad = [
      { ...ok, rating: undefined },
      { ...ok, rating: "up" },
      { ...ok, score: 5 },
      { ...ok, outcome: "dismissed" },
      { ...ok, surface: "main" },
      { surface: "call", kind: "nps", outcome: "answered", score: 5 },
      { surface: "main", kind: "nps", outcome: "answered" },
      { surface: "main", kind: "nps", outcome: "answered", score: 5, rating: "up" },
      { surface: "main", kind: "nps", outcome: "answered", score: 11 },
      { surface: "main", kind: "nps", outcome: "answered", score: "9" },
    ];
    for (const props of bad) expect(validateEvent("feedback_given", props), JSON.stringify(props)).toBeNull();
    expect(validateEvent("feedback_given", { ...ok, reason: "because the agent deleted my notes" })).toEqual({ ...ok, reason: undefined });
  });
});
