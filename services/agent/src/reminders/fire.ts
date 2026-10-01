import type { LiveServerMsg, ReminderWire } from "@openlive/shared";
import { log } from "../log.js";
import { spokenTime } from "./time.js";

// How an item that went off reaches the user: a native notification from
// Electron main, over the same parent port the computer-use helper asks main to
// raise a window on, and a line every open call and Flow socket shows and says.
// Web-only dev has no parent, so there the socket is all there is.

export type ReminderMsg = Extract<LiveServerMsg, { t: "reminder" }>;

/** Each open call and Flow socket, by how to send it one. Sessions add themselves and leave on close. */
export const liveSockets = new Set<(m: ReminderMsg) => void>();

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
  if (!port && !liveSockets.size) log.warn("reminders", `${m.title}: ${m.body} (nothing open to show it)`);
}
