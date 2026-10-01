import { Hono, type Context } from "hono";
import { z } from "zod";
import { NOTES_MAX } from "@openlive/shared";
import { addNote, clearNotes, deleteNote, editNote, memoryWire, type NoteResult } from "./notes.js";

// The /memory REST surface, behind the agent's shared-secret gate. Every
// change answers with the whole list, since one note joining or leaving moves
// the prompt budget's cutoff for the others.

export const memoryRoutes = new Hono();

const REFUSED = {
  empty: ["Write something to remember.", 400],
  duplicate: ["That is already remembered.", 409],
  full: [`Memory holds ${NOTES_MAX} notes. Delete some to make room.`, 409],
  missing: ["not found", 404],
} as const;

const text = z.object({ text: z.string() });

async function textOf(c: Context): Promise<string | null> {
  try { const r = text.safeParse(await c.req.json()); return r.success ? r.data.text : null; }
  catch { return null; }
}

memoryRoutes.get("/", (c) => c.json(memoryWire()));

const saved = (c: Context, r: NoteResult<keyof typeof REFUSED>, status: 200 | 201) => {
  if (r.ok) return c.json(memoryWire(), status);
  const [error, code] = REFUSED[r.reason];
  return c.json({ error }, code);
};

memoryRoutes.post("/", async (c) => {
  const t = await textOf(c);
  return t === null ? c.json({ error: "send { text }" }, 400) : saved(c, await addNote(t), 201);
});

memoryRoutes.put("/note/:id", async (c) => {
  const t = await textOf(c);
  return t === null ? c.json({ error: "send { text }" }, 400) : saved(c, await editNote(c.req.param("id"), t), 200);
});

memoryRoutes.delete("/note/:id", async (c) =>
  (await deleteNote(c.req.param("id"))) ? c.json(memoryWire()) : c.json({ error: "not found" }, 404));

memoryRoutes.delete("/", async (c) => { await clearNotes(); return c.json(memoryWire()); });
