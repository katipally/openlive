import { z } from "zod";

// The rich ACP tool-call model, shared verbatim by the agent service (which folds
// ACP session updates into it), the wire (sse-events), persistence (MessageBlock
// "acp_tool"), and the web client (chatStore parts). Mirrors Zed's acp_thread
// ToolCall + update_fields merge semantics: a delta's absent field means "leave
// unchanged"; content/locations are full replacements.

export const toolKindSchema = z.enum([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
]);
export type ToolKind = z.infer<typeof toolKindSchema>;

// ACP has the first four; "canceled" (barge-in / turn abort) and "rejected"
// (user denied permission) are client-side outcomes, same as Zed.
export const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "canceled", "rejected"]);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

export const toolLocationSchema = z.object({ path: z.string(), line: z.number().nullish() });
export type ToolLocation = z.infer<typeof toolLocationSchema>;

export const toolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullish(), // null/absent = new file
    newText: z.string(),
    clipped: z.boolean().optional(), // emit-time size cap hit
  }),
  z.object({
    type: z.literal("terminal"),
    terminalId: z.string(),
    // Filled at persist time so saved transcripts replay without a live terminal.
    output: z.string().optional(),
    exitCode: z.number().nullish(),
  }),
]);
export type ToolContent = z.infer<typeof toolContentSchema>;

export const toolCallStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: toolKindSchema,
  status: toolStatusSchema,
  content: z.array(toolContentSchema),
  locations: z.array(toolLocationSchema),
  rawInputJson: z.string().optional(),
  rawOutputJson: z.string().optional(),
});
export type ToolCallState = z.infer<typeof toolCallStateSchema>;

export const toolCallDeltaSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  kind: toolKindSchema.optional(),
  status: toolStatusSchema.optional(),
  content: z.array(toolContentSchema).optional(),
  locations: z.array(toolLocationSchema).optional(),
  rawInputJson: z.string().optional(),
  rawOutputJson: z.string().optional(),
});
export type ToolCallDelta = z.infer<typeof toolCallDeltaSchema>;

/** Fold a sparse delta into a tool call, returning a NEW object (React-safe).
 *  A delta for an id we never saw synthesizes a failed placeholder (Zed parity:
 *  an update must never vanish silently). */
export function mergeToolCall(existing: ToolCallState | undefined, delta: ToolCallDelta): ToolCallState {
  const base: ToolCallState = existing ?? {
    id: delta.id,
    title: delta.title ?? "Unknown tool",
    kind: "other",
    status: delta.status ?? "failed",
    content: [],
    locations: [],
  };
  return {
    ...base,
    ...(delta.title !== undefined ? { title: delta.title } : {}),
    ...(delta.kind !== undefined ? { kind: delta.kind } : {}),
    ...(delta.status !== undefined ? { status: delta.status } : {}),
    ...(delta.content !== undefined ? { content: delta.content } : {}),
    ...(delta.locations !== undefined ? { locations: delta.locations } : {}),
    ...(delta.rawInputJson !== undefined ? { rawInputJson: delta.rawInputJson } : {}),
    ...(delta.rawOutputJson !== undefined ? { rawOutputJson: delta.rawOutputJson } : {}),
  };
}

/** Render-time rule (Zed parity): rawOutput is only shown as content when the
 *  agent sent no real content — a later content arrival naturally wins. */
export function visibleContent(call: ToolCallState): ToolContent[] {
  if (call.content.length) return call.content;
  if (call.rawOutputJson) return [{ type: "text", text: call.rawOutputJson }];
  return [];
}

// Emit-time size caps: a runaway diff/log must not balloon the WS frame, the DB
// row, or browser memory. Clipping keeps the HEAD of diffs/text (the part the
// user reads first) — terminals cap separately (tail) in the terminal manager.
export const RAW_JSON_CAP = 16 * 1024;
export const TEXT_CONTENT_CAP = 64 * 1024;
export const DIFF_CONTENT_CAP = 256 * 1024;

export const capRawJson = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : s.length > RAW_JSON_CAP ? `${s.slice(0, RAW_JSON_CAP)}…` : s;

export function capToolContent(c: ToolContent): ToolContent {
  if (c.type === "text" && c.text.length > TEXT_CONTENT_CAP) return { ...c, text: `${c.text.slice(0, TEXT_CONTENT_CAP)}…` };
  if (c.type === "diff") {
    const total = (c.oldText?.length ?? 0) + c.newText.length;
    if (total > DIFF_CONTENT_CAP) {
      // Halve the budget across both sides; a one-sided diff gets the full cap.
      const budget = c.oldText ? DIFF_CONTENT_CAP / 2 : DIFF_CONTENT_CAP;
      return {
        ...c,
        oldText: c.oldText ? c.oldText.slice(0, budget) : c.oldText,
        newText: c.newText.slice(0, budget),
        clipped: true,
      };
    }
  }
  return c;
}
