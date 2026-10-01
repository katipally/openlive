"use strict";
// The per-event caps and dedupe windows the schema declares. `admit` says whether
// one validated event may go out and, when it may, counts it. Day counts and
// once-only keys persist through the state file; launch counts and dedupe
// windows live for one run.
const { localDay } = require("./state.cjs");

const tuple = (keys, props) => (keys ?? []).map((k) => props[k] ?? "").join("|");

function createLimits({ schema, state, now }) {
  const once = new Set(state.data.once);
  const launch = new Map();
  const seenAt = new Map();

  return {
    admit(name, props) {
      const limit = schema.events[name]?.limit;
      if (!limit) return true;
      const t = now();
      const { caps } = state.data;
      const day = localDay(t);
      if (caps.day !== day) {
        caps.day = day;
        caps.n = {};
      }

      const onceKey = limit.oncePerInstall ? name : limit.oncePerValueOf ? `${name}:${props[limit.oncePerValueOf]}` : null;
      const launchKey = limit.perLaunch ? `${name}|${tuple(limit.launchKey, props)}` : null;
      const dayKey = limit.perDay ? `d:${name}` : null;
      const dayPerKey = limit.perDayPerKey ? `k:${name}|${tuple(limit.dayKey, props)}` : null;
      const dedupeKey = limit.dedupeMs ? `${name}|${tuple(limit.dedupeKey, props)}` : null;

      if (onceKey && once.has(onceKey)) return false;
      if (launchKey && (launch.get(launchKey) ?? 0) >= limit.perLaunch) return false;
      if (dayKey && (caps.n[dayKey] ?? 0) >= limit.perDay) return false;
      if (dayPerKey && (caps.n[dayPerKey] ?? 0) >= limit.perDayPerKey) return false;
      if (dedupeKey && t - (seenAt.get(dedupeKey) ?? -Infinity) < limit.dedupeMs) return false;

      if (onceKey) {
        once.add(onceKey);
        state.data.once.push(onceKey);
      }
      if (launchKey) launch.set(launchKey, (launch.get(launchKey) ?? 0) + 1);
      for (const k of [dayKey, dayPerKey]) if (k) caps.n[k] = (caps.n[k] ?? 0) + 1;
      if (dedupeKey) seenAt.set(dedupeKey, t);
      if (onceKey || dayKey || dayPerKey) state.saveSoon();
      return true;
    },
    /** Start the once-only keys and day counts over, for a new install ID. */
    reset() {
      once.clear();
      state.data.once = [];
      state.data.caps = { day: "", n: {} };
    },
  };
}

module.exports = { createLimits };
