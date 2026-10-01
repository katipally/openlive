"use strict";
// When OpenLive may ask how it is doing, and what it keeps of the answer. Every cap is here and in
// schema.feedback, so no page decides for itself: a page asks `next()` for a prompt and reports what the
// person did. Nothing is asked while sharing is off or the first-run notice is owed (`open` is false),
// because nothing would be sent. The state is the `prompts` record of telemetry.json.
const { localDay } = require("./state.cjs");
const { validateEvent } = require("./validate.cjs");

const DAY = 86_400_000;
const HOUR = 3_600_000;
// A prompt the page never reported on (a reload, a crash) stops blocking the next one after this.
const PENDING_MS = 600_000;

const bucket = (turns) => (turns <= 2 ? "2" : turns <= 5 ? "3_5" : turns <= 10 ? "6_10" : "11_plus");

/** The first cap that says wait, or "" when `kind` may show now. Pure: the remembered state, the caps and the clock. */
function wait({ p, caps, now, firstOpenAt, kind }) {
  const since = (at) => now - at;
  if (p.never) return "never";
  if (firstOpenAt === null || since(firstOpenAt) < caps.minDaysAfterFirstOpen * DAY) return "new_install";
  if (now < p.backoffUntil) return "backoff";
  if (since(p.lastAt) < caps.minDaysBetweenPrompts * DAY) return "recent_prompt";
  if (p.lastDay === localDay(now)) return "same_day";
  if (kind === "nps") {
    if (!p.activated || p.activeDays < caps.npsMinActiveDays) return "not_active_enough";
    if (since(p.lastNpsAt) < caps.minDaysBetweenNps * DAY) return "recent_nps";
  } else if (since(p.lastSessionAt) < caps.minDaysBetweenSessionRatings * DAY) return "recent_rating";
  return "";
}

function createFeedback({ caps, state, now, submit, open, busy }) {
  const p = state.data.prompts;
  let candidate = null; // the latest session worth rating, in memory only
  let pending = null; // the prompt a page is showing

  /** A clock that was set forward and then back leaves times in the future, which would mute prompts for as long as it was off: they become now, and a back-off cannot outlast its own length. */
  function mendClock(t) {
    const before = JSON.stringify([p, state.data.firstOpenAt]);
    for (const k of ["lastAt", "lastSessionAt", "lastNpsAt"]) p[k] = Math.min(p[k], t);
    p.backoffUntil = Math.min(p.backoffUntil, t + caps.backoffDays * DAY);
    if (state.data.firstOpenAt !== null) state.data.firstOpenAt = Math.min(state.data.firstOpenAt, t);
    if (before !== JSON.stringify([p, state.data.firstOpenAt])) state.saveSoon();
  }

  function show(kind, ctx) {
    const t = now();
    p.lastAt = t;
    p.lastDay = localDay(t);
    if (kind === "nps") p.lastNpsAt = t;
    else p.lastSessionAt = t;
    pending = { kind, ctx, at: t };
    state.saveSoon();
    return { kind, surface: ctx.surface };
  }

  function resolve(outcome, { rating, score, reason } = {}) {
    if (!pending) return;
    const { kind, ctx } = pending;
    pending = null;
    const nps = kind === "nps";
    const draft = (o, more) => validateEvent("feedback_given", { ...ctx, kind, outcome: o, ...more });
    const given = outcome === "answered" ? (nps ? { score } : { rating, reason: rating === "down" ? reason : undefined }) : undefined;
    const props = draft(outcome, given) ?? draft("dismissed");
    if (!props) return;
    const result = props.outcome;
    if (result === "answered") p.ignoredInARow = 0;
    else if (result === "never_again") p.never = true;
    else if (++p.ignoredInARow >= caps.ignoredInARowForBackoff) p.backoffUntil = now() + caps.backoffDays * DAY;
    state.saveSoon();
    submit("feedback_given", props);
  }

  return {
    /** A Flow or call summary was emitted: remember it as worth rating when enough of its turns were answered. */
    noteSession(event, props) {
      if (props.turns - (props.errors ?? 0) < caps.sessionMinAnsweredTurns) return;
      candidate = { at: now(), ctx: { surface: event === "flow_session" ? "flow" : "call", brain_kind: props.brain_kind, brain_id: props.brain_id, turns_bucket: bucket(props.turns) } };
    },
    /** The prompt to show now, or null. Counting it as shown is part of handing it out. */
    next() {
      const t = now();
      if (!open() || busy()) return null;
      mendClock(t);
      if (pending && t - pending.at < PENDING_MS) return null;
      resolve("ignored");
      if (candidate && t - candidate.at > caps.sessionFreshHours * HOUR) candidate = null;
      const may = (kind) => !wait({ p, caps, now: t, firstOpenAt: state.data.firstOpenAt, kind });
      if (candidate && may("session_rating")) {
        const { ctx } = candidate;
        candidate = null;
        return show("session_rating", ctx);
      }
      return may("nps") ? show("nps", { surface: "main" }) : null;
    },
    answer: (a) => resolve(a.outcome, a),
    /** The app is going away with a prompt up: that was not an answer. */
    abandon: () => resolve("ignored"),
    /** The app was used today; `activeDays` counts distinct local days. */
    activeToday() {
      const day = localDay(now());
      if (p.lastActiveDay === day) return;
      p.lastActiveDay = day;
      p.activeDays++;
      state.saveSoon();
    },
    activated() {
      if (p.activated) return;
      p.activated = true;
      state.saveSoon();
    },
    allowed: () => !p.never,
    allow(yes) {
      p.never = !yes;
      state.saveSoon();
    },
    /** Sharing went off: forget what was waiting, send nothing. */
    discard() {
      candidate = null;
      pending = null;
    },
  };
}

module.exports = { createFeedback, wait };
