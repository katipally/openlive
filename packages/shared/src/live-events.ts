import { z } from "zod";
import { sseEventSchema } from "./sse-events";
import { AGENT_IDS } from "./agent-registry";

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
  // A bound coding agent (Claude Code / Codex / Cursor) wants permission to do
  // something (run a command, edit files). The client speaks the question and shows
  // approve/deny chips; the answer comes back as permission_response.
  z.object({ t: z.literal("permission"), reqId: z.string(), question: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })) }),
  // The bound agent's selectable models + modes (learned when it connects), so the
  // UI can offer model/mode pickers. Sent on connect and after a switch.
  z.object({
    t: z.literal("agent_meta"),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
    currentModelId: z.string().nullable(),
    modes: z.array(z.object({ id: z.string(), name: z.string() })),
    currentModeId: z.string().nullable(),
    // Other ACP session config options the agent exposes (thought/reasoning level,
    // model config, …) — rendered generically as dropdowns.
    options: z.array(z.object({
      id: z.string(), label: z.string(), category: z.string(),
      values: z.array(z.object({ id: z.string(), name: z.string() })), currentId: z.string().nullable(),
    })).default([]),
    // Whether the session can be reopened in the agent's own CLI after a restart
    // (Claude yes, Cursor no, Codex best-effort) — drives an honest UI badge.
    resumeAcrossRestart: z.boolean().default(true),
  }),
  // A session/load replay just finished and its turns were persisted — the client
  // should refetch this chat's messages so the recovered transcript shows.
  z.object({ t: z.literal("reload_history") }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type LiveServerMsg = z.infer<typeof liveServerMsgSchema>;

/** The coding agents a conversation can be bound to (null = built-in provider).
 *  Derived from the shared agent registry — the single source of agent identity. */
export const AGENT_ID = z.enum(AGENT_IDS);
export type AgentIdWire = z.infer<typeof AGENT_ID>;
export type AgentOptionWire = { id: string; label: string; category: string; values: { id: string; name: string }[]; currentId: string | null };
export type AgentMetaWire = { models: { id: string; name: string }[]; currentModelId: string | null; modes: { id: string; name: string }[]; currentModeId: string | null; options: AgentOptionWire[]; resumeAcrossRestart: boolean };

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
  // Bind (or unbind) this conversation to a coding agent + set its project folder.
  // Sent on connect (from the client's remembered choice) and whenever the user
  // switches agents OR the project folder. null agentId = the built-in provider brain.
  z.object({ t: z.literal("bind"), agentId: AGENT_ID.nullable(), cwd: z.string().optional(), resumeSessionId: z.string().optional() }),
  // The user's answer to a permission request (chip tap or a spoken yes/no).
  z.object({ t: z.literal("permission_response"), reqId: z.string(), optionId: z.string() }),
  // Switch the bound agent's model / mode mid-session (ACP set_model / set_mode).
  z.object({ t: z.literal("set_model"), modelId: z.string() }),
  z.object({ t: z.literal("set_mode"), modeId: z.string() }),
  // Set any other ACP session config option (thought/reasoning level, …).
  z.object({ t: z.literal("set_option"), optionId: z.string(), valueId: z.string() }),
]);
export type LiveClientMsg = z.infer<typeof liveClientMsgSchema>;
