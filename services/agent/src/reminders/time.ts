import type { ReminderRepeat } from "@openlive/shared";

// Wall-clock time in an IANA zone, with Intl alone: what a reminder's time says,
// what a spoken "6pm" means, and when a repeat comes round again across a DST change.

const DAY_MS = 86_400_000;
/** Farther ahead than this is a mistake, and past it a Date stops being one. */
const MAX_AHEAD_MS = 10 * 366 * DAY_MS;

/** The zone this machine is set to: the user's own. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

const formats = new Map<string, Intl.DateTimeFormat>();
/** One formatter per zone and shape: building one costs far more than using it. */
function format(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts })));
  return f;
}

const WALL: Intl.DateTimeFormatOptions = { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };

/** What a clock in `tz` reads at instant `t`. */
function wall(t: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of format(tz, WALL).formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

const asUtc = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** The instant a clock in `tz` reads `w`. Twice round, because the offset at the
 *  first guess can differ from the offset at the answer across a DST change. */
function instant(w: Wall, tz: string): number {
  const naive = asUtc(w);
  let t = naive - (asUtc(wall(naive, tz)) - naive);
  t = naive - (asUtc(wall(t, tz)) - t);
  return t;
}

/** The calendar date `days` after `w`'s, at `w`'s time. */
function addDays(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
  return { ...w, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const weekday = (w: Wall) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
const isWeekday = (w: Wall) => weekday(w) >= 1 && weekday(w) <= 5;

/**
 * When an item due at `due` comes round next after `after`, at the same wall-clock
 * time in `tz`, so 9 AM stays 9 AM through a DST change. Starts a day before
 * `after` rather than stepping from `due`, so an item missed for a year costs no
 * more than one missed yesterday: O(1), at most about ten steps.
 */
export function nextOccurrence(due: number, repeat: Exclude<ReminderRepeat, "none">, tz: string, after: number): number {
  const at = wall(due, tz);
  const from = wall(Math.max(due, after), tz);
  let w: Wall = addDays({ ...at, y: from.y, mo: from.mo, d: from.d }, -1);
  if (repeat === "weekly") w = addDays(w, -((weekday(w) - weekday(at) + 7) % 7));
  const step = repeat === "weekly" ? 7 : 1;
  while (instant(w, tz) <= after || (repeat === "weekdays" && !isWeekday(w))) w = addDays(w, step);
  return instant(w, tz);
}

/** A weekday repeat set for a weekend starts on the next weekday. */
export const firstOccurrence = (due: number, repeat: ReminderRepeat, tz: string): number =>
  repeat === "weekdays" && !isWeekday(wall(due, tz)) ? nextOccurrence(due, repeat, tz, due) : due;

// ── reading what the model sent ──────────────────────────────────────────────

export type Parsed = { ok: true; at: number } | { ok: false; error: string };

const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;
const SHORT_DURATION = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/;

/**
 * A duration in ms: ISO 8601 ("PT10M", "P1DT2H"), seconds ("600"), or the short
 * form models reach for ("1h30m"). Null when it is none of those. Years and
 * months are refused: their length depends on when they start.
 */
export function parseDuration(v: string): number | null {
  const s = v.trim().replace(/\s+/g, "");
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s) * 1000;
  const iso = ISO_DURATION.exec(s);
  if (iso && /\d/.test(s)) {
    const [, w = 0, d = 0, h = 0, m = 0, sec = 0] = iso.map((x) => Number(x ?? 0));
    return ((((w * 7 + d) * 24 + h) * 60 + m) * 60 + sec) * 1000;
  }
  const short = SHORT_DURATION.exec(s.toLowerCase());
  if (short && s) {
    const [, h = 0, m = 0, sec = 0] = short.map((x) => Number(x ?? 0));
    return ((h * 60 + m) * 60 + sec) * 1000;
  }
  return null;
}

/** When a duration from now ends, or why it cannot. */
export function afterDuration(v: string, now: number): Parsed {
  const ms = parseDuration(v);
  if (ms === null) return { ok: false, error: `"${v}" is not a duration. Use ISO 8601 like PT10M or P1DT2H, or a number of seconds.` };
  if (ms <= 0) return { ok: false, error: "The duration has to be more than zero." };
  if (ms > MAX_AHEAD_MS) return { ok: false, error: "That is more than ten years away." };
  return { ok: true, at: now + ms };
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})$/i;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant `at` names. A local date-time ("2026-10-01T18:00") is read in
 * `tz`; one with an offset or Z is taken as given; a bare clock time ("18:00")
 * is its next occurrence, today or tomorrow. A time already past is refused,
 * saying what time it is now, so the model can correct itself.
 */
export function parseAt(at: string, now: number, tz: string): Parsed {
  const s = at.trim();
  let t: number;
  const clock = CLOCK.exec(s), local = LOCAL.exec(s), offset = OFFSET.exec(s);
  if (clock) {
    const [h, mi, sec] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
    if (h > 23 || mi > 59 || sec > 59) return { ok: false, error: `"${at}" is not a time of day.` };
    const today = { ...wall(now, tz), h, mi, s: sec };
    t = instant(today, tz);
    if (t <= now) t = instant(addDays(today, 1), tz);
  } else if (local) {
    const w = { y: +local[1]!, mo: +local[2]!, d: +local[3]!, h: +local[4]!, mi: +local[5]!, s: +(local[6] ?? 0) };
    const check = new Date(asUtc(w));
    if (w.h > 23 || w.mi > 59 || w.s > 59 || check.getUTCMonth() + 1 !== w.mo || check.getUTCDate() !== w.d) return { ok: false, error: `"${at}" is not a real date and time.` };
    t = instant(w, tz);
  } else if (offset) {
    const zone = offset[3]!.toUpperCase() === "Z" ? "Z" : offset[3]!.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    t = Date.parse(`${offset[1]}T${offset[2]}${zone}`);
    if (!Number.isFinite(t)) return { ok: false, error: `"${at}" is not a real date and time.` };
  } else {
    return { ok: false, error: `"${at}" is not a time OpenLive reads. Use a local date and time like 2026-10-01T18:00, a clock time like 18:00, or a duration with "in".` };
  }
  if (t <= now) return { ok: false, error: `${spokenTime(t, now, tz)} has already passed. It is now ${spokenTime(now, now, tz)}.` };
  if (t - now > MAX_AHEAD_MS) return { ok: false, error: "That is more than ten years away." };
  return { ok: true, at: t };
}

// ── saying it back ───────────────────────────────────────────────────────────

// ICU puts a narrow no-break space before AM and PM; a model and a voice read a plain one better.
const plain = (s: string) => s.replace(/\s/g, " ");

const zoneName = (t: number, tz: string) =>
  format(tz, { timeZoneName: "short" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? tz;

/** "6:00 PM today (PDT)", "9:00 AM tomorrow (PDT)", "6:00 PM on Friday, October 3 (PDT)". */
export function spokenTime(t: number, now: number, tz: string): string {
  const clock = plain(format(tz, { hour: "numeric", minute: "2-digit" }).format(t));
  const day = Math.round((asUtc({ ...wall(t, tz), h: 0, mi: 0, s: 0 }) - asUtc({ ...wall(now, tz), h: 0, mi: 0, s: 0 })) / DAY_MS);
  const when = day === 0 ? "today" : day === 1 ? "tomorrow" : day === -1 ? "yesterday"
    : `on ${format(tz, { weekday: "long", month: "long", day: "numeric", ...(wall(t, tz).y !== wall(now, tz).y && { year: "numeric" }) }).format(t)}`;
  return `${clock} ${when} (${zoneName(t, tz)})`;
}

/** "It is now 3:04 PM on Thursday, October 1, 2026 (America/Los_Angeles, PDT)." */
export function nowLine(now: number, tz: string): string {
  const clock = plain(format(tz, { hour: "numeric", minute: "2-digit" }).format(now));
  const date = format(tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now);
  return `It is now ${clock} on ${date} (${tz}, ${zoneName(now, tz)}).`;
}

/** "1 hour 30 minutes", "45 seconds". */
export function spokenDuration(ms: number): string {
  let s = Math.round(ms / 1000);
  const parts: string[] = [];
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]] as const) {
    const n = Math.floor(s / size);
    s -= n * size;
    if (n) parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" ") || "0 seconds";
}
