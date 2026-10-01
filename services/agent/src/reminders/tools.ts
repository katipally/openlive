import { getReminders, updateReminders } from "@openlive/db";
import type { ReminderRepeat, ReminderWire } from "@openlive/shared";
import { deliver } from "./fire.js";
import { Scheduler } from "./scheduler.js";
import { afterDuration, firstOccurrence, localZone, nowLine, parseAt, parseDuration, spokenDuration, spokenTime } from "./time.js";
import type { Tool, ToolResult } from "../capabilities/types.js";

// Timers and reminders for every brain, through the registry and the openlive
// MCP server alike. None asks first: each only schedules a note to the user
// themselves, says the time back for them to hear, and is undone by a cancel,
// so a question before each would cost a spoken exchange to guard nothing.

/** The scheduler the server starts, and every session's tools reach. */
export const reminders = new Scheduler({ read: getReminders, update: updateReminders, fire: (r, late) => deliver(r, late) });

const TEXT_MAX = 200;
const REPEATS = ["none", "daily", "weekdays", "weekly"] as const satisfies readonly ReminderRepeat[];

const result = <D>(text: string, details: D): ToolResult<D> => ({ content: [{ type: "text", text }], details });

const repeatWords = (r: ReminderRepeat) => (r === "none" ? "" : r === "weekdays" ? ", then every weekday" : `, then ${r}`);

/** One item as list and cancel name it: its id, when, and what. */
function line(r: ReminderWire, now: number): string {
  const what = r.kind === "timer" ? `Timer${r.text ? ` "${r.text}"` : ""}` : `Reminder "${r.text}"`;
  const status = r.status === "pending" ? "" : ` [${r.status}]`;
  return `- ${r.id}: ${what} at ${spokenTime(Date.parse(r.dueAt), now, r.tz)}${repeatWords(r.repeat)}${status}`;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

/** The four tools, over `s`, so a test can hand them a scheduler of its own. */
export function reminderTools(s: Scheduler): Tool[] {
  const setTimer: Tool<{ duration: string; label?: string }, { item: ReminderWire }> = {
    name: "set_timer",
    group: "reminders",
    description: "Start a timer. It goes off with a notification and a spoken line even if this conversation has ended, and works offline. The result says when it ends: tell the user in a few words.",
    parameters: {
      type: "object",
      properties: {
        duration: { type: "string", description: "How long: ISO 8601 like PT10M or PT1H30M, or a number of seconds." },
        label: { type: "string", description: "What it is for, in a few words, like \"pasta\". Leave out when they gave none." },
      },
      required: ["duration"],
    },
    async execute({ duration, label }) {
      const now = Date.now(), tz = localZone();
      const end = afterDuration(duration, now);
      if (!end.ok) throw new Error(end.error);
      const item = await s.add({ kind: "timer", text: clean(label), dueAt: end.at, tz, repeat: "none" });
      return result(`Timer set for ${spokenDuration(parseDuration(duration)!)}${item.text ? ` (${item.text})` : ""}. It ends at ${spokenTime(end.at, now, tz)}. Id ${item.id}.`, { item });
    },
  };

  const remind: Tool<{ text: string; at?: string; in?: string; repeat?: ReminderRepeat }, { item: ReminderWire }> = {
    name: "remind",
    group: "reminders",
    description: "Remind the user of something at a time. It goes off with a notification and a spoken line even if this conversation has ended, and works offline. Give `at` or `in`, not both. The result says the time it resolved to: tell the user in a few words.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind them of, short, as they would want to hear it: \"call the bank\"." },
        at: { type: "string", description: "When, in the user's own local time and without an offset: 2026-10-01T18:00, or just 18:00 for its next occurrence. One with an offset or Z is taken as given." },
        in: { type: "string", description: "Or how long from now: ISO 8601 like PT20M or P1D, or a number of seconds." },
        repeat: { type: "string", enum: [...REPEATS], description: "Whether it comes round again, at the same local time. Defaults to none." },
      },
      required: ["text"],
    },
    async execute(args) {
      const now = Date.now(), tz = localZone();
      const text = clean(args.text);
      if (!text) throw new Error("Say what to remind them of.");
      if (!!args.at === !!args.in) throw new Error("Give exactly one of `at` (a local time) or `in` (a duration).");
      const when = args.at ? parseAt(args.at, now, tz) : afterDuration(args.in!, now);
      if (!when.ok) throw new Error(when.error);
      const repeat = args.repeat ?? "none";
      const dueAt = firstOccurrence(when.at, repeat, tz);
      const item = await s.add({ kind: "reminder", text, dueAt, tz, repeat });
      return result(`Reminder set for ${spokenTime(dueAt, now, tz)}${repeatWords(repeat)}: ${text}. Id ${item.id}.`, { item });
    },
  };

  const list: Tool<{ include_done?: boolean }, { items: ReminderWire[] }> = {
    name: "list_reminders",
    group: "reminders",
    readOnly: true,
    description: "List the user's pending timers and reminders, soonest first, with their ids and the current local time.",
    parameters: {
      type: "object",
      properties: { include_done: { type: "boolean", description: "Also list the ones that already went off or were cancelled." } },
    },
    async execute({ include_done }) {
      const now = Date.now();
      const items = s.list(!!include_done);
      const body = items.length ? items.map((r) => line(r, now)).join("\n") : "Nothing pending.";
      return result(`${nowLine(now, localZone())}\n${body}`, { items });
    },
  };

  const cancel: Tool<{ id?: string; text_match?: string }, { cancelled: ReminderWire | null; candidates: ReminderWire[] }> = {
    name: "cancel_reminder",
    group: "reminders",
    description: "Cancel a pending timer or reminder, by its id or by words from its text. When several match, nothing is cancelled and the matches are listed: ask the user which, or cancel by id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Its id, from list_reminders or the result that set it." },
        text_match: { type: "string", description: "Or words from its text or label, like \"bank\"." },
      },
    },
    async execute({ id, text_match }) {
      const now = Date.now();
      const words = clean(text_match).toLowerCase();
      if (!id && !words) throw new Error("Give an id or words from its text.");
      const all = s.list();
      const matches = id ? all.filter((r) => r.id === id.trim()) : all.filter((r) => r.text.toLowerCase().includes(words));
      if (matches.length > 1) return result(`${matches.length} match, so none was cancelled:\n${matches.map((r) => line(r, now)).join("\n")}`, { cancelled: null, candidates: matches });
      const hit = matches[0] && await s.cancel(matches[0].id);
      if (!hit) throw new Error(`No pending timer or reminder ${id ? `has id ${id}` : `mentions "${text_match}"`}.${all.length ? "" : " Nothing is pending."}`);
      return result(`Cancelled: ${line(matches[0]!, now).slice(2)}`, { cancelled: hit, candidates: [] });
    },
  };

  return [setTimer, remind, list, cancel];
}

export const REMINDER_TOOLS = reminderTools(reminders);

/**
 * The local time, for a request whose tools can schedule, so "at 6pm" and
 * "tomorrow" resolve. It rides the request's transient tail, never the cached
 * system prompt, which would then change every minute. "" when nothing schedules.
 */
export const clockNote = (tools: readonly Tool[], now = Date.now()): string =>
  tools.some((t) => t.group === "reminders") ? nowLine(now, localZone()) : "";
