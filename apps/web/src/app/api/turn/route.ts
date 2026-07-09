import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { encodeSse, type SseEvent } from "@openlive/shared";
import { runLiveTurn } from "@/lib/turn/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One live voice turn. The client sends the prior turns (text) + the new user
// text + the freshest camera frame + its provider/model/key. We run the tool
// loop server-side (so every provider works — no browser CORS) and stream the
// reply back as SSE. Barge-in = the client aborts the fetch → req.signal aborts
// → the LLM stream stops. Stateless: nothing is persisted.
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }

  const provider = BUILTIN_PROVIDERS.find((p) => p.id === body?.providerId);
  if (!provider) return new Response("unknown provider", { status: 400 });

  const eff = typeof body?.effort === "string" ? body.effort : "";
  const effort = eff && eff !== "auto" && eff !== "none" ? eff : undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const emit = (e: SseEvent) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(encodeSse(e))); } catch { closed = true; }
      };
      try {
        await runLiveTurn({
          provider,
          model: String(body?.model ?? ""),
          apiKey: body?.apiKey || undefined,
          effort,
          history: Array.isArray(body?.history) ? body.history : [],
          text: String(body?.text ?? ""),
          frame: body?.frame && body.frame.data ? body.frame : undefined,
          cameraOn: !!body?.cameraOn,
          emit,
          signal: req.signal,
        });
      } catch (e: any) {
        if (!req.signal.aborted) emit({ type: "error", message: String(e?.message ?? e) });
      }
      emit({ type: "done" });
      if (!closed) { try { controller.close(); } catch { /* already closed */ } }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
