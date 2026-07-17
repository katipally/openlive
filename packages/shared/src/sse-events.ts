import { z } from "zod";
import { toolCallDeltaSchema, toolCallStateSchema } from "./tool-call";

// The wire protocol between the agent service and the browser. One JSON object
// per SSE `data:` line. In OpenLive these are wrapped by the live WS server
// (`{t:"sse", event}`) and decoded into the chat store on the client. This is the
// LIVE subset — no canvas / source / ask_user events (those belonged to the full
// chat app OpenLive was ported from, which it drops).

export const sseEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("reasoning_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_start"), id: z.string(), tool: z.string(), summary: z.string().optional() }),
  z.object({ type: z.literal("tool_done"), id: z.string(), detail: z.string().optional() }),
  // Rich ACP tool calls (coding agents): a full snapshot on tool_call, then
  // sparse deltas that merge via mergeToolCall. The legacy tool_start/tool_done
  // pair above stays for the built-in brain and old persisted transcripts.
  z.object({ type: z.literal("acp_tool_call"), call: toolCallStateSchema }),
  z.object({ type: z.literal("acp_tool_update"), delta: toolCallDeltaSchema }),
  // Live output from a client-hosted ACP terminal (terminal/create). Chunks are
  // batched server-side; `truncated` means the head of the buffer was dropped.
  z.object({ type: z.literal("term_output"), terminalId: z.string(), chunk: z.string(), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("term_exit"), terminalId: z.string(), exitCode: z.number().nullish(), signal: z.string().nullish() }),
  // The agent's working checklist (update_todos tool), shown in the UI.
  z.object({ type: z.literal("todos"), items: z.array(z.object({ text: z.string(), done: z.boolean() })) }),
  z.object({
    type: z.literal("usage"),
    contextTokens: z.number(),
    // ACP usage_update carries used/size/cost — no output-token count. The field
    // is optional so the ACP path can omit it instead of fabricating a 0.
    outputTokens: z.number().optional(),
    contextSize: z.number().optional(),
    costUsd: z.number(),
  }),
  z.object({ type: z.literal("status"), text: z.string().nullable() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type SseEvent = z.infer<typeof sseEventSchema>;
