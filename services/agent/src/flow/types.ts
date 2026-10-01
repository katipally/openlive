import type { Message, ToolDef } from "@openlive/harness";
import type { ErrorClass, FlowEventWire } from "@openlive/shared";
// The Flow harness speaks the canonical harness message shape so a transcript
// goes to a provider, to disk and over ACP unchanged.
export type Msg = Message;
export type ToolSpec = ToolDef;

export interface Usage { input: number; output: number }

/** What `runFlow` yields. Identical to the wire union, so forwarding is a cast-free pass-through. */
export type FlowEvent = FlowEventWire;

export interface TurnRequest {
  systemPrompt: string;
  messages: Msg[];
  tools: ToolSpec[];
  /** What is on screen this turn: the newest window state and the app in front.
   *  Sent after the conversation on this request only. Kept out of `systemPrompt`
   *  and `messages`, which lead every request: one changed byte there and the
   *  provider's prompt cache misses the whole conversation behind it. */
  tail?: { text: string; images?: { data: string; mime: string }[] };
}

export type BrainEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  /** Best effort: strings may be cut mid-word, arrays may be short, `{}` means nothing parsed yet. Never undefined. */
  | { type: "tool_args_delta"; id: string; argsPartial: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; args: Record<string, unknown> }
  /** Never spoken or shown. Kept only to be handed back: Anthropic refuses a
   *  tool result whose call lost the signed thinking in front of it. */
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_signature"; signature: string }
  | { type: "turn_done"; stop: "stop" | "tools" | "length"; usage?: Usage }
  | { type: "turn_error"; message: string; aborted: boolean; code?: ErrorClass };

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
