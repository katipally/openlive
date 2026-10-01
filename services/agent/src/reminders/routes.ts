import { Hono } from "hono";
import type { RemindersWire } from "@openlive/shared";
import { reminders } from "./tools.js";

// The /reminders REST surface, behind the agent's shared-secret gate: what is
// coming up, for Settings, and cancelling one.

export const reminderRoutes = new Hono();

const wire = (): RemindersWire => ({ items: reminders.list() });

reminderRoutes.get("/", (c) => c.json(wire()));

reminderRoutes.delete("/:id", async (c) => {
  try {
    return (await reminders.cancel(c.req.param("id"))) ? c.json(wire()) : c.json({ error: "No pending timer or reminder has that id." }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
