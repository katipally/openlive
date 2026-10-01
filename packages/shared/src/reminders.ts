// What the agent's /reminders routes send: timers and reminders, kept in
// state/reminders.json and fired by the agent even with no call open.

export type ReminderKind = "timer" | "reminder";
export type ReminderRepeat = "none" | "daily" | "weekdays" | "weekly";
export type ReminderStatus = "pending" | "fired" | "missed" | "cancelled";

export interface ReminderWire {
  id: string;
  kind: ReminderKind;
  /** What to remind about; a timer's label, "" when it has none. */
  text: string;
  /** UTC ISO. A repeating item's moves to its next occurrence each time it fires. */
  dueAt: string;
  createdAt: string;
  /** The IANA zone it was set in, which a repeat keeps its wall-clock time in. */
  tz: string;
  repeat: ReminderRepeat;
  status: ReminderStatus;
}

/** The pending items, soonest first. */
export interface RemindersWire {
  items: ReminderWire[];
}
