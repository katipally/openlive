import { Hono } from "hono";
import { z } from "zod";
import type { EditsWire } from "@openlive/shared";
import { recentEdits, undoById } from "./checkpoints.js";

// The /edits REST surface, behind the agent's shared-secret gate: the recent
// edits OpenLive's file tools made, for Settings, and undoing one.

export const editRoutes = new Hono();

const SHOWN = 20;
const wire = async (): Promise<EditsWire> => ({ items: await recentEdits(SHOWN) });

editRoutes.get("/", async (c) => c.json(await wire()));

editRoutes.post("/:id/undo", async (c) => {
  const b = z.object({ force: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Send force as true or false." }, 400);
  try {
    return (await undoById(c.req.param("id"), b.data.force)) ? c.json(await wire()) : c.json({ error: "No kept edit has that id." }, 404);
  } catch (e) {
    // A refusal the person can read: the file changed since, or its copy was cleared.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});
