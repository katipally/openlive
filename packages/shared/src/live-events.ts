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

// ── language ──────────────────────────────────────────────────────────────
// The one language a voice session runs in: the browser transcribes and speaks
// it, and each turn carries it so the model answers in it too.
export const LANGUAGE_CODES = ["en", "es", "fr", "de", "it", "pt", "hi", "zh", "ja", "ko"] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];
export const languageSchema = z.enum(LANGUAGE_CODES);
/** How the model is told to write it. Mandarin, simplified: the voices and
 *  transcribers for "zh" are Mandarin, and they read simplified characters. */
const REPLY_LANGUAGE: Record<LanguageCode, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  hi: "Hindi", zh: "Mandarin Chinese, in simplified characters", ja: "Japanese", ko: "Korean",
};
/** The one instruction a non-English session adds; "" for English, so an
 *  English prompt stays exactly what it was. */
export const replyLanguageLine = (lang?: LanguageCode): string =>
  !lang || lang === "en" ? "" : `Always reply in ${REPLY_LANGUAGE[lang]}.`;
/** A coding agent over ACP takes no system prompt per turn, so the line rides
 *  at the head of what the user said. */
export const withReplyLanguage = (text: string, lang?: LanguageCode): string => {
  const line = replyLanguageLine(lang);
  return line ? `[${line}]\n\n${text}` : text;
};

/** Numbers a user turn, client-side. The server echoes it on every event of the
 *  reply, so a cancelled turn's late events cannot land in the turn after it. */
const turnIdSchema = z.number().int();

/** First byte of a binary WS message. */
export const LIVE_TAG = {
  FRAME_IN: 0x02, // client→server: JPEG camera frame (freshest-per-turn or `look`)
} as const;

// ── Flow (ambient voice mode) ─────────────────────────────────────────────
// Flow rides the SAME /live socket as chat: same permission protocol, same
// cancel, one connection. Its turns carry their own event union because the
// Flow harness has its own loop and tool shape, and folding them into the chat
// SSE union would change shapes chat already depends on.

/** Free metadata captured for a Flow turn. Never pixels. */
export const flowContextSchema = z.object({
  app: z.string().optional(),
  windowTitle: z.string().optional(),
  selection: z.string().optional(),
  url: z.string().optional(),
  screen: z.object({ width: z.number(), height: z.number(), scale: z.number() }).optional(),
  capturedAt: z.number(),
});

/** Model-facing tool output. Bounded by the tool, not by the transport. */
export const flowContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mime: z.string() }),
]);

export const flowEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("tool_start"), id: z.string(), name: z.string() }),
  // Best-effort parse of the arguments streamed so far: strings may be cut
  // mid-word and arrays may be short. Speculate on it, never act on it.
  z.object({ type: z.literal("tool_args_delta"), id: z.string(), argsPartial: z.record(z.unknown()) }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.record(z.unknown()) }),
  z.object({
    type: z.literal("tool_result"), id: z.string(), name: z.string(),
    content: z.array(flowContentSchema), isError: z.boolean(), details: z.unknown().optional(),
  }),
  z.object({ type: z.literal("context"), context: flowContextSchema }),
  z.object({ type: z.literal("turn_end"), stop: z.enum(["stop", "tools", "length"]), usage: z.object({ input: z.number(), output: z.number() }).optional() }),
  z.object({ type: z.literal("error"), message: z.string(), aborted: z.boolean() }),
  z.object({ type: z.literal("done"), reason: z.enum(["no_tools", "terminate", "host_stop", "error", "aborted"]) }),
]);
export type FlowEventWire = z.infer<typeof flowEventSchema>;
export type FlowContextWire = z.infer<typeof flowContextSchema>;
export type FlowContentWire = z.infer<typeof flowContentSchema>;

// ── server → client (JSON) ────────────────────────────────────────────────
export const liveServerMsgSchema = z.discriminatedUnion("t", [
  // Wrap an ordinary chat SSE event so the browser reuses the existing reducer.
  // `turn` echoes the user_text the event answers; absent on events outside a turn.
  z.object({ t: z.literal("sse"), event: sseEventSchema, turn: turnIdSchema.optional() }),
  // Ask the client for ONE fresh hi-res frame (the `look` tool). The client
  // replies with a frame_response then sends the JPEG as the next binary frame.
  z.object({ t: z.literal("need_frame"), reqId: z.string() }),
  // Run an OS action on the user's machine (clipboard / open a URL) — desktop
  // only. The client executes it via the Electron bridge and replies with
  // tool_bridge_result. Enables agent-side clipboard_read/write + open_url tools.
  // Flow adds three ops on the same handshake: `flow_insert` (arg is
  // `{"id","chunk"}`) pushes the next chunk of a streaming insertion, `flow_insert_end`
  // (arg is the call id) closes it, and `flow_context` reads the foreground window
  // metadata back as JSON. `flow_device` carries one perception or control call
  // into the ol-input addon (arg is `{"fn","args"}`, the reply is `{"value"}` or
  // `{"error"}`), so the agent service never needs the addon in its own process.
  // Chat never sends them. `turn`, like on permission and elicitation, is the
  // reply's number, so a cancelled turn's late ask never reaches the next turn.
  z.object({ t: z.literal("tool_bridge"), reqId: z.string(), op: z.enum(["clipboard_read", "clipboard_write", "open_url", "flow_insert", "flow_insert_end", "flow_context", "flow_device"]), arg: z.string().optional(), turn: turnIdSchema.optional() }),
  // A bound coding agent (Claude Code / Codex / Cursor) wants permission to do
  // something (run a command, edit files). The client speaks the question and shows
  // approve/deny chips; the answer comes back as permission_response.
  // expiresAt (epoch ms): when the server auto-denies an unanswered ask — drives
  // the client's visible countdown + spoken reminder.
  // `kind` (ACP option kind) drives voice yes/no mapping + button styling;
  // `toolCallId` interleaves the ask on that tool's card in the activity panel.
  z.object({
    t: z.literal("permission"), reqId: z.string(), question: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]).optional() })),
    expiresAt: z.number().optional(), toolCallId: z.string().optional(), turn: turnIdSchema.optional(),
  }),
  // A permission ask is no longer awaiting the user (answered, auto-denied, or the
  // turn was cancelled) — the client dismisses its chip so a later utterance isn't
  // mis-read as a yes/no answer.
  z.object({ t: z.literal("permission_resolved"), reqId: z.string() }),
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
  // An agent elicitation: a login/OAuth URL to open (mode "url") or an input
  // form to fill (mode "form", `schema` is the ACP ElicitationSchema — flat,
  // primitive-typed). Answered with elicitation_response; `elicitation_resolved`
  // dismisses the card (answered elsewhere, agent-side completion, or timeout).
  z.object({
    t: z.literal("elicitation"), reqId: z.string(), mode: z.enum(["url", "form"]),
    message: z.string(), url: z.string().optional(), schema: z.unknown().optional(), expiresAt: z.number().optional(),
    turn: turnIdSchema.optional(),
  }),
  z.object({ t: z.literal("elicitation_resolved"), reqId: z.string() }),
  // A session/load replay just finished and its turns were persisted — the client
  // should refetch this chat's messages so the recovered transcript shows.
  z.object({ t: z.literal("reload_history") }),
  // Authoritative result of a bind: the agent + folder this session is ACTUALLY
  // using and whether the coding agent is running. Sent after every applyBind so
  // the client can reconcile its optimistic chips — a folder shown in the top bar
  // that the session never received is exactly the bug this closes.
  z.object({ t: z.literal("bound_state"), agentId: z.enum(AGENT_IDS).nullable(), cwd: z.string(), agentActive: z.boolean() }),
  // One event of a Flow turn. Wrapped rather than inlined so the client routes
  // Flow to its owner window and chat to the chat store, unchanged.
  z.object({ t: z.literal("flow"), event: flowEventSchema, turn: turnIdSchema.optional() }),
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
    // The session language, read as the turn is sent, so a change applies from
    // the next turn. Absent means English.
    lang: languageSchema.optional(),
    turn: turnIdSchema.optional(),
  }),
  // Barge-in: the user started talking over the agent — abort the in-flight LLM
  // stream. Audio is stopped locally; this only stops the server generating.
  // `spoken` is what the on-device TTS actually voiced before the cut, so the
  // server persists only that (not the text it generated ahead of the voice).
  z.object({ t: z.literal("cancel"), spoken: z.string().optional() }),
  z.object({ t: z.literal("control"), action: z.enum(["camera_on", "camera_off", "screen_on", "screen_off", "end"]) }),
  // Answer to need_frame; the hi-res JPEG follows as the next FRAME_IN binary.
  // `failed`: the grab failed and no JPEG follows, so the look settles now.
  z.object({ t: z.literal("frame_response"), reqId: z.string(), failed: z.boolean().optional() }),
  // Result of a tool_bridge OS action (clipboard text / ok / error message).
  z.object({ t: z.literal("tool_bridge_result"), reqId: z.string(), output: z.string() }),
  // Bind (or unbind) this conversation to a coding agent + set its project folder.
  // Sent on connect (from the client's remembered choice) and whenever the user
  // switches agents OR the project folder. null agentId = the built-in provider brain.
  z.object({ t: z.literal("bind"), agentId: AGENT_ID.nullable(), cwd: z.string().optional(), resumeSessionId: z.string().optional() }),
  // The user's answer to a permission request (chip tap or a spoken yes/no).
  z.object({ t: z.literal("permission_response"), reqId: z.string(), optionId: z.string() }),
  // The user's answer to an elicitation (form submit / "done" / cancel).
  z.object({ t: z.literal("elicitation_response"), reqId: z.string(), action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.unknown()).optional() }),
  // Switch the bound agent's model / mode mid-session (ACP set_model / set_mode).
  z.object({ t: z.literal("set_model"), modelId: z.string() }),
  z.object({ t: z.literal("set_mode"), modeId: z.string() }),
  // Set any other ACP session config option (thought/reasoning level, …).
  z.object({ t: z.literal("set_option"), optionId: z.string(), valueId: z.string() }),
  // A completed Flow utterance, with the metadata the desktop captured as the
  // user spoke it. Approval answers reuse `permission_response`.
  z.object({ t: z.literal("flow_text"), text: z.string(), context: flowContextSchema.optional(), lang: languageSchema.optional(), turn: turnIdSchema.optional() }),
  // Barge-in on a Flow turn. Separate from `cancel` so a Flow turn and a chat
  // turn on the same socket can never abort each other. `spoken` is what the
  // on-device TTS actually voiced before the cut, so only that is persisted.
  // `close` means Flow itself went away, so an open ask is refused with it.
  z.object({ t: z.literal("flow_cancel"), spoken: z.string().optional(), close: z.boolean().optional() }),
  // Continue an archived Flow session: the next utterance appends to that file
  // and the brain is given the turns it already holds, instead of starting over.
  z.object({ t: z.literal("flow_resume"), sessionId: z.string() }),
  // Start a fresh Flow session: the next utterance opens a new file and transcript.
  z.object({ t: z.literal("flow_new") }),
]);
export type LiveClientMsg = z.infer<typeof liveClientMsgSchema>;
