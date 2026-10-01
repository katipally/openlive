"use strict";
// Holds the one open Flow record and the one open call record, folds the small
// facts that arrive from three processes into them by the schema's fold rules,
// and hands one summary event to `emit` when the record closes. Per-turn facts
// never leave the machine: only the folded record does.
const { clamp } = require("./validate.cjs");

const EARLY_MS = 10_000;
const GRACE_MS = 2_000;
const MAX_PENDING = 64;
const MAX_SAMPLES = 256;
// Main knows better than any renderer why a record ended when the app itself is quitting.
const QUIT_REASON = { flow_session: "quit", call_session: "app_quit" };

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

function createAggregator({ schema, now, random, timers, emit, graceMs = GRACE_MS, earlyMs = EARLY_MS }) {
  const open = new Map();
  let pending = [];

  const eventOf = (scope) => schema.facts[scope].event;

  function fold(rec, scope, props) {
    const specs = schema.facts[scope].props;
    for (const [key, v] of Object.entries(props)) {
      const spec = specs[key];
      if (!spec) continue;
      const prev = rec.values.get(key);
      switch (spec.fold) {
        case "sum":
          rec.values.set(key, Math.min(spec.max, (prev ?? 0) + v));
          break;
        case "max":
          rec.values.set(key, Math.max(prev ?? v, v));
          break;
        case "or":
          rec.values.set(key, prev || v);
          break;
        case "samples": {
          // A reservoir keeps a long session's memory flat and its percentiles fair.
          const s = rec.samples.get(key) ?? { seen: 0, list: [], spec };
          rec.samples.set(key, s);
          s.seen++;
          if (s.list.length < MAX_SAMPLES) s.list.push(v);
          else {
            const j = Math.floor(random() * s.seen);
            if (j < MAX_SAMPLES) s.list[j] = v;
          }
          break;
        }
        default:
          rec.values.set(key, v);
      }
    }
  }

  function summary(event, rec) {
    const spec = schema.events[event];
    const out = Object.fromEntries(rec.values);
    for (const { list, spec: s } of rec.samples.values()) {
      const sorted = list.slice().sort((a, b) => a - b);
      out[s.into.p50] = percentile(sorted, 0.5);
      if (s.into.p95) out[s.into.p95] = percentile(sorted, 0.95);
    }
    for (const [prop, sources] of Object.entries(spec.derive ?? {})) out[prop] = sources.some((k) => out[k] > 0);
    for (const [prop, p] of Object.entries(spec.props)) {
      if (!p.opt && out[prop] === undefined) out[prop] = p.k === "bool" ? false : 0;
    }
    const { reason } = rec.closing;
    const ended = reason === QUIT_REASON[event] ? reason : (rec.values.get("ended_by") ?? reason);
    out.ended_by = spec.props.ended_by.values.includes(ended) ? ended : "other";
    out.duration_s = clamp(spec.props.duration_s, Math.round((rec.closing.at - rec.openedAt) / 1000));
    return out;
  }

  function finish(event) {
    const rec = open.get(event);
    if (!rec) return;
    if (rec.timer) timers.clearTimeout(rec.timer);
    open.delete(event);
    emit(event, summary(event, rec));
  }

  function begin(event) {
    if (open.has(event)) {
      open.get(event).closing ??= { at: now(), reason: "other" };
      finish(event);
    }
    const t = now();
    const rec = { openedAt: t, values: new Map(), samples: new Map(), closing: null, timer: null };
    open.set(event, rec);
    const early = pending.filter((f) => eventOf(f.scope) === event && t - f.at <= earlyMs);
    pending = pending.filter((f) => eventOf(f.scope) !== event && t - f.at <= earlyMs);
    for (const f of early) fold(rec, f.scope, f.props);
  }

  function end(event, reason) {
    const rec = open.get(event);
    if (!rec || rec.closing) return;
    rec.closing = { at: now(), reason };
    // The renderer's last fact and the close signal travel separately: wait a beat for a straggler.
    rec.timer = timers.setTimeout(() => finish(event), graceMs);
    rec.timer.unref?.();
  }

  return {
    openFlow: () => begin("flow_session"),
    closeFlow: (reason) => end("flow_session", reason),
    openCall: () => begin("call_session"),
    closeCall: (reason) => end("call_session", reason),
    /** A delta for the open record of that scope; held for up to 10 s when none is open yet, then dropped. */
    fact(scope, props) {
      const rec = open.get(eventOf(scope));
      if (rec) return fold(rec, scope, props);
      const t = now();
      pending = [...pending.filter((f) => t - f.at <= earlyMs), { scope, props, at: t }].slice(-MAX_PENDING);
    },
    /** A Flow or call record is open, or still in its grace period. */
    busy: () => open.size > 0,
    /** The app is quitting: close and emit whatever is open now. */
    flush() {
      for (const event of [...open.keys()]) {
        end(event, QUIT_REASON[event]);
        finish(event);
      }
    },
    /** Forget everything without sending it, for a person who turned telemetry off. */
    discard() {
      for (const rec of open.values()) if (rec.timer) timers.clearTimeout(rec.timer);
      open.clear();
      pending = [];
    },
  };
}

module.exports = { createAggregator, EARLY_MS, GRACE_MS };
