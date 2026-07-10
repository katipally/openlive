import { z } from "zod";
import { sseEventSchema } from "./sse-events";

// The live-mode wire protocol between the browser and the agent's /live
// WebSocket. THICK CLIENT: the browser runs the whole voice stack (VAD, STT,
// turn detection, TTS) on-device, so the socket only carries TEXT + camera
// frames + a cancel signal — no audio. The server is a thin LLM proxy that
// streams reply text back (reusing the chat SSE union verbatim so the browser
// feeds it into the same chatStore reducer: artifacts, page images, usage all
// render unchanged) and persists the conversation.
//   • BINARY frames — a 1-byte tag. Only camera JPEGs travel this way now.
//   • TEXT frames — the JSON discriminated unions below.

/** First byte of a binary WS message. */
export const LIVE_TAG = {
  FRAME_IN: 0x02, // client→server: JPEG camera frame (freshest-per-turn or `look`)
} as const;

// ── server → client (JSON) ────────────────────────────────────────────────
export const liveServerMsgSchema = z.discriminatedUnion("t", [
  // Wrap an ordinary chat SSE event so the browser reuses the existing reducer.
  z.object({ t: z.literal("sse"), event: sseEventSchema }),
  // Ask the client for ONE fresh hi-res frame (the `look` tool). The client
  // replies with a frame_response then sends the JPEG as the next binary frame.
  z.object({ t: z.literal("need_frame"), reqId: z.string() }),
  // Run an OS action on the user's machine (clipboard / open a URL) — desktop
  // only. The client executes it via the Electron bridge and replies with
  // tool_bridge_result. Enables agent-side clipboard_read/write + open_url tools.
  z.object({ t: z.literal("tool_bridge"), reqId: z.string(), op: z.enum(["clipboard_read", "clipboard_write", "open_url"]), arg: z.string().optional() }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type LiveServerMsg = z.infer<typeof liveServerMsgSchema>;

// ── client → server (JSON) ────────────────────────────────────────────────
export const liveClientMsgSchema = z.discriminatedUnion("t", [
  // A completed user turn: the on-device STT's final transcript, plus the freshest
  // frame(s) from any active visual source (camera and/or screen), base64 inline.
  // Inline (not binary) so both sources arrive atomically with the turn — no
  // accumulation/timing races. `source` labels each frame so the model is told
  // whether it's a camera or a screen.
  z.object({
    t: z.literal("user_text"),
    text: z.string(),
    frames: z.array(z.object({ data: z.string(), mime: z.string(), source: z.enum(["camera", "screen"]) })).optional(),
  }),
  // Barge-in: the user started talking over the agent — abort the in-flight LLM
  // stream. Audio is stopped locally; this only stops the server generating.
  // `spoken` is what the on-device TTS actually voiced before the cut, so the
  // server persists only that (not the text it generated ahead of the voice).
  z.object({ t: z.literal("cancel"), spoken: z.string().optional() }),
  z.object({ t: z.literal("control"), action: z.enum(["camera_on", "camera_off", "screen_on", "screen_off", "end"]) }),
  // Answer to need_frame; the hi-res JPEG follows as the next FRAME_IN binary.
  z.object({ t: z.literal("frame_response"), reqId: z.string() }),
  // Result of a tool_bridge OS action (clipboard text / ok / error message).
  z.object({ t: z.literal("tool_bridge_result"), reqId: z.string(), output: z.string() }),
]);
export type LiveClientMsg = z.infer<typeof liveClientMsgSchema>;

export function encodeLiveMsg(m: LiveServerMsg | LiveClientMsg): string {
  return JSON.stringify(m);
}
