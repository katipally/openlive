import type { LiveServerMsg, ReminderWire } from "@openlive/shared";
import { log } from "../log.js";
import { spokenTime } from "./time.js";

// How an item that went off reaches the user: a native notification from
// Electron main, over the same parent port the computer-use helper asks main to
// raise a window on, and a line every open call and Flow socket shows and says.
// Web-only dev has no parent, so there the socket is all there is, and one that
// goes off with none open is kept until the next one opens.

export type ReminderMsg = Extract<LiveServerMsg, { t: "reminder" }>;

/** Each open call and Flow socket, by how to send it one. Sessions join with hearReminders and leave on close. */
export const liveSockets = new Set<(m: ReminderMsg) => void>();

/** What went off with nothing to show it, oldest first, the newest UNHEARD_MAX kept. */
const unheard: ReminderWire[] = [];
const UNHEARD_MAX = 20;

/** A socket joins, and hears as missed whatever went off while none was open. */
export function hearReminders(send: (m: ReminderMsg) => void): void {
  liveSockets.add(send);
  for (const r of unheard.splice(0)) {
    try { send(reminderMsg(r, true)); } catch (e) { log.warn("reminders", "live:", e); }
  }
}

export interface ParentPort { postMessage(message: unknown): void }

/** What the notification and the spoken line say. A late one says it was missed, and when it was due. */
export function reminderMsg(r: ReminderWire, late: boolean, now = Date.now()): ReminderMsg {
  const title = r.kind === "timer" ? "Timer" : "Reminder";
  const said = r.kind === "timer" ? (r.text ? `${r.text}. Time's up.` : "Time's up.") : r.text;
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  return { t: "reminder", title, body: late ? `Missed: ${sentence} It was due ${spokenTime(Date.parse(r.dueAt), now, r.tz)}.` : said };
}

/** Never throws: one dead socket or a closed port must not keep the others from hearing. */
export function deliver(r: ReminderWire, late: boolean, port = (process as { parentPort?: ParentPort }).parentPort): void {
  const m = reminderMsg(r, late);
  try { port?.postMessage({ openlive: "notify", title: m.title, body: m.body }); }
  catch (e) { log.warn("reminders", "notify:", e); }
  for (const send of liveSockets) {
    try { send(m); } catch (e) { log.warn("reminders", "live:", e); }
  }
  if (port || liveSockets.size) return;
  unheard.push(r);
  if (unheard.length > UNHEARD_MAX) unheard.shift();
  log.warn("reminders", `${m.title}: ${m.body} (nothing open to show it yet)`);
}
