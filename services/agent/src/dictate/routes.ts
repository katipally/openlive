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
  // One JSON object a line: { delta } as the words come, then { text } or { error }.
  const ac = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const enc = new TextEncoder();
  const words = new ReadableStream<Uint8Array>({
    async start(out) {
      const line = (o: object) => { if (!ac.signal.aborted) out.enqueue(enc.encode(`${JSON.stringify(o)}\n`)); };
      try { line({ text: await rewrite(parsed.data as RewriteAsk, ac.signal, (delta) => line({ delta })) }); }
      catch (e) {
        log.warn("dictate", "rewrite:", e);
        line({ error: e instanceof Error ? e.message : "no answer came back" });
      }
      try { out.close(); } catch { /* the reader hung up */ }
    },
    cancel() { ac.abort(); },
  });
  return new Response(words, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
});

dictateRoutes.post("/warm", (c) => { warm(); return c.json({ ok: true }); });
