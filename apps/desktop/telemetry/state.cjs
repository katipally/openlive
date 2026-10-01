"use strict";
// <home>/state/telemetry.json: the install ID, the person's choice and the small
// counters the sender needs to stay quiet. Only main touches it, so a temp file
// and a rename is all the locking it wants. A file that cannot be read starts over.
// <home>/state/telemetry-off is the opt-out's second copy: it exists only while the file could
// not record "off", and while it does, sharing stays off.
const path = require("node:path");
const { isUuid } = require("./validate.cjs");

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const orNull = (test) => (v) => v === null || test(v);
const isString = (v) => typeof v === "string";
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// What the feedback prompts remember (feedback.cjs): when one last showed, how many were ignored in a
// row, the days the app was used, and the person's "don't ask again". Times are epoch ms, 0 for never.
const PROMPTS = { never: false, lastAt: 0, lastDay: "", lastSessionAt: 0, lastNpsAt: 0, ignoredInARow: 0, backoffUntil: 0, activeDays: 0, lastActiveDay: "", activated: false };
const isPrompts = (v) => isRecord(v) && Object.entries(PROMPTS).every(([k, d]) => typeof v[k] === typeof d);

// Each field: its starting value, and what a stored value must look like to be kept.
const fields = {
  v: [1, isNumber],
  installId: [null, orNull(isUuid)],
  enabled: [true, (v) => typeof v === "boolean"],
  noticeSeenAt: [null, orNull(isNumber)],
  firstOpenAt: [null, orNull(isNumber)],
  // The first-open event's own two enums, held until the notice has been shown.
  pendingFirstOpen: [null, orNull(isRecord)],
  lastVersion: [null, orNull(isString)],
  reportedReadiness: [null, orNull(isString)],
  // Once-only events already sent: `name`, or `name:value`.
  once: [() => [], (v) => Array.isArray(v) && v.every(isString)],
  // Today's per-key event counts.
  caps: [() => ({ day: "", n: {} }), (v) => isRecord(v) && isString(v.day) && isRecord(v.n)],
  // Feature counters since the last send, and when the last one was counted: they are sent under that time, not the day they left.
  featureBucket: [() => ({}), isRecord],
  featureBucketAt: [null, orNull(isNumber)],
  prompts: [() => ({ ...PROMPTS }), isPrompts],
};

const initial = () => Object.fromEntries(Object.entries(fields).map(([k, [v]]) => [k, typeof v === "function" ? v() : v]));

/** Only the fields we own, each of the shape we expect, so an edited or damaged file cannot reach the sender. */
function sanitize(raw) {
  const data = initial();
  if (isRecord(raw)) for (const [key, [, keep]] of Object.entries(fields)) if (keep(raw[key])) data[key] = raw[key];
  return data;
}

/** The local calendar day, as YYYY-MM-DD. Never sent. */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Sleeps the thread: save() runs at quit, so it cannot wait on a timer.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Swap `tmp` into place. A scanner can hold the file for a moment on Windows, so wait once, then write it in place: a lost opt-out would turn telemetry back on. */
function replace(fs, tmp, file, text) {
  try {
    fs.renameSync(tmp, file);
  } catch {
    pause(50);
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, text, { mode: 0o600 });
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}

/** Write `text` to `file` through a temp file and a rename, so a crash leaves the old file or the new one, never half of either. */
function writeAtomic(fs, file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  replace(fs, tmp, file, text);
}

function createState({ dir, fs, timers, saveDelayMs = 1500 }) {
  const file = path.join(dir, "telemetry.json");
  const offFile = path.join(dir, "telemetry-off");
  let raw = null;
  // Whether a file was there at all, readable or not: one that was has already reported this install's first open.
  let existed = false;
  try {
    const text = fs.readFileSync(file, "utf8");
    existed = true;
    raw = JSON.parse(text);
  } catch {}
  const data = sanitize(raw);
  let offMarked = fs.existsSync(offFile);
  if (offMarked) data.enabled = false;
  let timer = null;

  function save() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(fs, file, JSON.stringify(data));
    } catch {
      return data.enabled || markOff();
    }
    if (offMarked) {
      try {
        fs.unlinkSync(offFile);
        offMarked = false;
      } catch {}
    }
  }

  function markOff() {
    try {
      fs.writeFileSync(offFile, "", { mode: 0o600 });
      offMarked = true;
    } catch {}
  }

  return {
    data,
    existed,
    save,
    saveSoon() {
      if (timer) return;
      timer = timers.setTimeout(save, saveDelayMs);
      timer.unref?.();
    },
  };
}

module.exports = { createState, localDay, writeAtomic };
