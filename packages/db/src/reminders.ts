import { join } from "node:path";
import type { ReminderWire } from "@openlive/shared";
import { readJson, updateJson } from "./store";
import { PATHS } from "./paths";

// Timers and reminders, oldest first. Only the agent writes them; its scheduler
// keeps the copy it arms from.

const REMINDERS = join(PATHS.state, "reminders.json");

export const getReminders = (): ReminderWire[] => readJson<ReminderWire[]>(REMINDERS, []);

/** Read, change and write them under the store's lock. Resolves to what was written. */
export const updateReminders = (fn: (cur: ReminderWire[]) => ReminderWire[]): Promise<ReminderWire[]> =>
  updateJson<ReminderWire[]>(REMINDERS, [], fn);
