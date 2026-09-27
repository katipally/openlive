import type { ProviderEvent, ToolCall } from "@openlive/harness";
import type { SseEvent } from "@openlive/shared";

export type Emit = (e: SseEvent) => Promise<void> | void;

// A request the user stopped stays in the model's history, and a model reading
// it unanswered picks it back up on the next unrelated turn.
const LEAVE_IT = "do not carry it out, finish it or answer it, unless they ask for it again.";
/** What a coding agent's next prompt says about the turn the user stopped. */
export const AGENT_CANCELLED = `[The user cancelled that request before you finished: ${LEAVE_IT}]`;
const CANCELLED_NOTE = `[The user cancelled this request before it was done: ${LEAVE_IT}]`;
/** A stopped request as the built-in brain's history keeps it. */
export const cancelledText = (text: string): string => (isCancelled(text) ? text : `${text}\n\n${CANCELLED_NOTE}`);
export const isCancelled = (text: string): boolean => text.endsWith(CANCELLED_NOTE);

/** A sentence the side talk check dropped and the user sent on by hand. */
export const sentAside = (text: string): string =>
  `[This was first taken for the user talking to someone else nearby, and they sent it on to you anyway. It may still be meant for another person: if it is nothing you can do, say so briefly, and never claim to have done it.]\n\n${text}`;

/** Parse streamed tool-arg JSON; tolerate an empty/blank string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeParseArgs(s: string): any {
  const t = (s ?? "").trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

export interface Turn {
  text: string;
  reasoning: string;
  reasoningSignature?: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}

/** Fold a provider's normalized event stream into one assistant turn, emitting
 *  text/reasoning deltas as it goes. */
export async function collectTurn(
  gen: AsyncGenerator<ProviderEvent>,
  emit: Emit,
): Promise<Turn> {
  let text = "";
  let reasoning = "";
  let reasoningSignature: string | undefined;
  const usage = { input: 0, output: 0 };
  // Tool-use blocks arrive as start + streamed JSON-arg deltas + stop, keyed by index.
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const ev of gen) {
    switch (ev.type) {
      case "text": {
        // Drop leading whitespace at the very start so a bubble never opens blank.
        let d = ev.delta;
        if (text.length === 0) { d = d.replace(/^\s+/, ""); if (!d) break; }
        text += d;
        await emit({ type: "text_delta", text: d });
        break;
      }
      case "reasoning":
        reasoning += ev.delta;
        await emit({ type: "reasoning_delta", text: ev.delta });
        break;
      case "reasoning_signature":
        reasoningSignature = ev.signature;
        break;
      case "tool_start":
        calls.set(ev.index, { id: ev.id, name: ev.name, args: "" });
        break;
      case "tool_delta": {
        const c = calls.get(ev.index);
        if (!c) break;
        c.args += ev.argsDelta;
        break;
      }
      case "tool_stop":
        break;
      case "usage":
        usage.input += ev.input;
        usage.output += ev.output;
        break;
      case "done":
        break;
    }
  }

  const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args }));
  return { text, reasoning, reasoningSignature, toolCalls, usage };
}
