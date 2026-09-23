import type { Message, ToolDef } from "@openlive/harness";
import type { FlowContentWire, FlowContextWire, FlowEventWire } from "@openlive/shared";
// The Flow harness speaks the canonical harness message shape so a transcript
// goes to a provider, to disk and over ACP unchanged.
export type Msg = Message;
export type ToolSpec = ToolDef;

export interface Usage { input: number; output: number }

/** The MCP server Flow publishes its tools as. Every harness namespaces a tool
 *  under this, so the preamble has to say it out loud. */
export const MCP_SERVER_NAME = "openlive-flow";

export type TextPart = Extract<FlowContentWire, { type: "text" }>;
export type ImagePart = Extract<FlowContentWire, { type: "image" }>;

/** Metadata captured around a turn. The wire schema is the source of truth. */
export type FlowContext = FlowContextWire;

/** What `runFlow` yields. Identical to the wire union, so forwarding is a cast-free pass-through. */
export type FlowEvent = FlowEventWire;

export interface ToolResult<D = unknown> {
  /** Bounded, model-facing. */
  content: (TextPart | ImagePart)[];
  /** Rich, UI-facing. Same return value, no second channel. */
  details: D;
  /** The tool believes the turn is finished. A batch ends the run only if every call agrees. */
  terminate?: boolean;
}

/**
 * Forward-only text insertion into whatever app the user is in.
 *
 * `commit` takes the WHOLE text known so far, not a chunk, and inserts only
 * what has not been inserted yet for this call id. Text that diverges from what
 * was already committed is dropped: the model does not get to rewrite words
 * already sitting in the user's document. Must not throw.
 */
export interface InsertionSink {
  commit(id: string, text: string): Promise<void>;
  end(id: string): Promise<void>;
  /**
   * End a call whose tool never ran. What it already typed becomes the baseline
   * for the next call, so the model's retry under a fresh id continues the
   * user's document instead of typing the same sentence a second time.
   */
  abandon(id: string): Promise<void>;
  /** How much of this call's text has already reached the user's app. */
  committed(id: string): string;
}

/** Reads and writes the system clipboard. Implementations must not throw for an empty clipboard. */
export interface ClipboardPort {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/**
 * Captures the free metadata around a turn. The native providers land in Block 4;
 * this is the seam they plug into. Must not throw: return null instead.
 */
export interface ContextProvider {
  capture(signal: AbortSignal): Promise<FlowContext | null>;
}

export interface ToolCtx {
  signal: AbortSignal;
  /** The metadata captured for this turn, or null when nothing could be read. */
  context: FlowContext | null;
  insert: InsertionSink;
  clipboard: ClipboardPort;
  /** The call id the model used, so a tool can address its own insertion stream. */
  callId: string;
}

export interface Tool<P = any, D = any> {
  name: string;
  description: string;
  /** JSON Schema. One object goes to the provider, to disk and over ACP unchanged. */
  parameters: Record<string, unknown>;
  /** Lines contributed to the system prompt when this tool is available. */
  promptGuidelines?: string[];
  execute(args: P, ctx: ToolCtx): Promise<ToolResult<D>>;
}

export interface TurnRequest {
  systemPrompt: string;
  messages: Msg[];
  tools: ToolSpec[];
}

export type BrainEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  /** Best effort: strings may be cut mid-word, arrays may be short, `{}` means nothing parsed yet. Never undefined. */
  | { type: "tool_args_delta"; id: string; argsPartial: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; args: Record<string, unknown> }
  | { type: "turn_done"; stop: "stop" | "tools" | "length"; usage?: Usage }
  | { type: "turn_error"; message: string; aborted: boolean };

/**
 * One turn of thinking, whatever is doing the thinking.
 *
 * Turn-shaped rather than model-shaped: an ACP agent that owns its own model and
 * prompt ignores the fields it does not need, and the loop never learns which
 * kind of brain it has.
 *
 * Contract, relied on by the loop: `stream` MUST NOT throw and MUST NOT reject.
 * Every failure is a terminal `turn_error` event. It MUST honour `signal`
 * promptly, because barge-in is the most important interaction in this product.
 */
export interface Brain {
  readonly id: string;
  stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<BrainEvent>;
}

/** May this call run? Must not throw; a throw is treated as a block. */
export type Approve = (
  req: { tool: Tool; args: unknown },
  signal: AbortSignal,
) => Promise<{ block: true; reason: string } | { block?: false }>;
