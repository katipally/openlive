import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DICTATE_BODY_MAX, DICTATE_TEXT_MAX } from "@openlive/shared";
import { log } from "../log.js";
import { rewrite, warm, type RewriteAsk } from "./rewrite.js";

// The /dictate REST surface, behind the agent's shared-secret gate. The
// browser hanging up (Dictate's deadline) aborts the brain's turn.

export const dictateRoutes = new Hono();

const ask = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("polish"), text: z.string().min(1).max(DICTATE_TEXT_MAX), tone: z.enum(["natural", "casual", "formal"]) }),
  z.object({ kind: z.literal("command"), text: z.string().min(1).max(DICTATE_TEXT_MAX), selection: z.string().max(DICTATE_TEXT_MAX) }),
]);

dictateRoutes.post("/rewrite", bodyLimit({ maxSize: DICTATE_BODY_MAX, onError: (c) => c.json({ error: "body too large" }, 413) }), async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { body = null; }
  const parsed = ask.safeParse(body);
  if (!parsed.success) return c.json({ error: "send { kind, text, tone | selection }" }, 400);
  try {
    return c.json({ text: await rewrite(parsed.data as RewriteAsk, c.req.raw.signal) });
  } catch (e) {
    log.warn("dictate", "rewrite:", e);
    return c.json({ error: e instanceof Error ? e.message : "the brain did not answer" }, 502);
  }
});

dictateRoutes.post("/warm", (c) => { warm(); return c.json({ ok: true }); });
