"use strict";
// The allowlist, as code. Pure: no electron, no fs, no clock. Whatever is not in
// schema.json is dropped, and nothing here throws: a bad prop loses that prop, a
// bad required prop loses the event.
const defaultSchema = require("./schema.json");

const patterns = new Map();
const pattern = (source) => {
  let re = patterns.get(source);
  if (!re) patterns.set(source, (re = new RegExp(source)));
  return re;
};

/** One value against one prop spec: the value as it will be sent (numbers rounded), or undefined. */
function coerce(spec, v) {
  switch (spec.k) {
    case "enum":
      return typeof v === "string" && spec.values.includes(v) ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "int":
    case "dec": {
      if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
      const unit = spec.k === "int" ? (spec.step ?? 1) : 10 ** -spec.places;
      const n = Math.round(v / unit) * unit;
      const rounded = spec.k === "dec" ? Number(n.toFixed(spec.places)) : n;
      return rounded < (spec.min ?? 0) || rounded > spec.max ? undefined : rounded + 0;
    }
    case "str":
      return typeof v === "string" && v.length <= spec.max && pattern(spec.pattern).test(v) ? v : undefined;
    default:
      return undefined;
  }
}

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The props of `input` that `specs` names and accepts. */
function clean(specs, input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(specs, key)) continue;
    const v = coerce(specs[key], input[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** `setting_changed` is valid only as a (setting, value) pair the table lists; a subject must be that setting's kind of id. */
function settingPair(out, schema) {
  const entry = Object.hasOwn(schema.settings, out.setting) ? schema.settings[out.setting] : undefined;
  if (!entry || !entry.values.includes(out.value)) return false;
  if (out.subject !== undefined && out.subject !== "none" && !schema.subjects[entry.subject]?.includes(out.subject)) delete out.subject;
  return true;
}

/** `feedback_given` is valid only as a coherent answer: the rating or score its kind takes exactly when answered, a reason only after a thumbs down, and NPS on the main window. */
function feedbackShape(o) {
  const nps = o.kind === "nps";
  const given = nps ? o.score : o.rating;
  const stray = nps ? o.rating : o.score;
  return nps === (o.surface === "main") && stray === undefined && (given !== undefined) === (o.outcome === "answered") && (o.reason === undefined || o.rating === "down");
}

/** The sendable props of an event, or null when the event is unknown or a required prop is missing or wrong. */
function validateEvent(name, props, schema = defaultSchema) {
  try {
    if (typeof name !== "string" || !Object.hasOwn(schema.events, name)) return null;
    const specs = schema.events[name].props;
    const out = clean(specs, props);
    for (const key of Object.keys(specs)) if (!specs[key].opt && !Object.hasOwn(out, key)) return null;
    if (name === "setting_changed" && !settingPair(out, schema)) return null;
    return name === "feedback_given" && !feedbackShape(out) ? null : out;
  } catch {
    return null;
  }
}

/** The usable part of a fact delta, or null for an unknown scope. */
function validateFact(scope, props, schema = defaultSchema) {
  try {
    return typeof scope === "string" && Object.hasOwn(schema.facts, scope) ? clean(schema.facts[scope].props, props) : null;
  } catch {
    return null;
  }
}

/** The properties every event carries, each as the schema allows. */
function validateCommon(props, schema = defaultSchema) {
  try {
    return clean(schema.common, props);
  } catch {
    return {};
  }
}

const isCounterKey = (key, schema = defaultSchema) => typeof key === "string" && schema.counters.includes(key);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID.test(v);

/** A number we computed, pinned into a spec's range: an extreme value goes out as the limit instead of dropping its event. */
const clamp = (spec, v) => Math.min(spec.max, Math.max(spec.min ?? 0, v));

module.exports = { coerce, validateEvent, validateFact, validateCommon, isCounterKey, isUuid, clamp };
