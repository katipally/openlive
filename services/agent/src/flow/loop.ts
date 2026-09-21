import { dispatch, toolSpecs, type FlowToolCall } from "./tools.js";
import { allowAll } from "./approval.js";
import { trimImages } from "./retention.js";
import { formatContext } from "./prompt.js";
import type {
  Approve, Brain, ClipboardPort, ContextProvider, FlowEvent, InsertionSink, Msg, TextPart, Tool, Usage,
} from "./types.js";

// The only control flow in Flow. Two levels: turns, and the events inside a
// turn. It owns no budget and counts no steps: a run ends because the data said
// so (no tool calls, every tool asked to stop, the host said stop, an error, or
// the user talked over it), never because a constant ran out.

export interface FlowRun {
  brain: Brain;
  tools: Tool[];
  /** The conversation. Appended to in place, so the host persists what it already holds. */
  messages: Msg[];
  signal: AbortSignal;
  insert: InsertionSink;
  clipboard: ClipboardPort;
  /** Resolved per turn. Must not throw. */
  getSystemPrompt: () => string | Promise<string>;
  context?: ContextProvider;
  approve?: Approve;
  /** False runs tools one at a time. Approval is sequential either way. */
  parallel?: boolean;
  /** Utterances that arrived mid-run, drained between turns. Must not throw. */
  pollSteering?: () => Msg[];
  /** Host policy: every limit Flow has lives here. Must not throw. */
  shouldStop?: () => boolean | Promise<boolean>;
  /** Raced against abort, so barge-in is never held up by a hook. Must not throw. */
  onTurnEnd?: (assistant: Msg) => void | Promise<void>;
  budget?: Budget;
}

export interface Budget {
  /** Tokens of context the model actually has. */
  limit: number;
  /** Headroom left for the reply and the tools it will call. */
  reserve: number;
  /** Messages kept when compacting. */
  tail: number;
}

export const DEFAULT_BUDGET: Budget = { limit: 128_000, reserve: 16_000, tail: 12 };

// ── context budget ──────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

function chars(m: Msg): number {
  if (m.role === "tool") return m.result.length + m.name.length;
  if (m.role === "assistant") return (m.text?.length ?? 0) + (m.toolCalls?.reduce((n, c) => n + c.arguments.length + c.name.length, 0) ?? 0);
  return m.text.length;
}

/**
 * What this conversation costs, without a tokenizer.
 *
 * The provider already counted everything up to its last reply, so that number
 * is used as-is and only what came after it is estimated. Four characters per
 * token is wrong for code and for CJK, which is why it is applied to the tail
 * and not to the whole transcript.
 */
export function estimateTokens(messages: Msg[], anchor: { index: number; tokens: number } | null): number {
  const from = anchor ? anchor.index + 1 : 0;
  let tail = 0;
  for (let i = from; i < messages.length; i++) tail += chars(messages[i]!);
  return (anchor?.tokens ?? 0) + Math.ceil(tail / CHARS_PER_TOKEN);
}

const TRIM_NOTE = "[Earlier in this conversation was dropped to fit the context window.]";

/**
 * Drop the oldest messages when the estimate eats into the reserve.
 *
 * The cut always lands on a user message: a tool result whose assistant call was
 * dropped is a message no provider will accept.
 */
export function compact(messages: Msg[], budget: Budget, anchor: { index: number; tokens: number } | null): Msg[] | null {
  if (estimateTokens(messages, anchor) <= budget.limit - budget.reserve) return null;
  let cut = Math.max(0, messages.length - budget.tail);
  while (cut < messages.length && messages[cut]!.role !== "user") cut++;
  if (cut === 0 || cut >= messages.length) return null;
  return [{ role: "user", text: TRIM_NOTE }, ...messages.slice(cut)];
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Resolve as soon as the hook finishes OR the user cuts in, whichever is first. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, () => resolve(undefined)).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const asText = (content: (TextPart | { type: "image" })[]): string =>
  content.filter((c): c is TextPart => c.type === "text").map((c) => c.text).join("\n") || "(no output)";

function assistantMessage(text: string, calls: FlowToolCall[]): Msg {
  return {
    role: "assistant",
    text: text || undefined,
    toolCalls: calls.length ? calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) : undefined,
  };
}

// The salvage parser will happily hand back arguments that parse and validate
// while being silently half-written, so a truncated message poisons every call
// in it, not just the last one.
const TRUNCATED = "The model ran out of room mid-call, so the arguments may be incomplete. Nothing was run. Say it again more briefly.";

// ── the loop ────────────────────────────────────────────────────────────────

export async function* runFlow(run: FlowRun): AsyncGenerator<FlowEvent> {
  const { brain, tools, messages, signal } = run;
  const approve = run.approve ?? allowAll;
  const budget = run.budget ?? DEFAULT_BUDGET;
  const specs = toolSpecs(tools);
  let anchor: { index: number; tokens: number } | null = null;
  // The calls of the turn in flight. Any insertion they opened is closed on the
  // way out, whichever way the run ends.
  let open: FlowToolCall[] = [];

  try {
    for (;;) {
      if (signal.aborted) { yield { type: "error", message: "Cancelled.", aborted: true }; yield { type: "done", reason: "aborted" }; return; }

      for (const m of run.pollSteering?.() ?? []) messages.push(m);

      const context = (await run.context?.capture(signal)) ?? null;
      if (context) yield { type: "context", context };

      // Dropping messages moves every index after them, and the anchor is an index.
      const trimmed = trimImages(messages);
      if (trimmed) { messages.splice(0, messages.length, ...trimmed); anchor = null; }

      const compacted = compact(messages, budget, anchor);
      if (compacted) { messages.splice(0, messages.length, ...compacted); anchor = null; }

      const systemPrompt = [await run.getSystemPrompt(), formatContext(context)].filter(Boolean).join("\n\n");

      let text = "";
      const calls: FlowToolCall[] = [];
      open = calls;
      let usage: Usage | undefined;
      let stop: "stop" | "tools" | "length" = "stop";
      let failure: { message: string; aborted: boolean } | null = null;

      for await (const ev of brain.stream({ systemPrompt, messages: [...messages], tools: specs }, signal)) {
        if (ev.type === "text_delta") { text += ev.delta; yield { type: "text_delta", delta: ev.delta }; continue; }
        if (ev.type === "tool_start") { calls.push({ id: ev.id, name: ev.name, args: {} }); yield { type: "tool_start", id: ev.id, name: ev.name }; continue; }
        if (ev.type === "tool_args_delta") {
          yield { type: "tool_args_delta", id: ev.id, argsPartial: ev.argsPartial };
          // The insertion sink is forward-only, so handing it the growing text is
          // safe to do before the call is even finished being written.
          const call = calls.find((c) => c.id === ev.id);
          if (call?.name === "insert_text" && typeof ev.argsPartial.text === "string") await run.insert.commit(ev.id, ev.argsPartial.text);
          continue;
        }
        if (ev.type === "tool_end") {
          const call = calls.find((c) => c.id === ev.id);
          if (call) call.args = ev.args; else calls.push({ id: ev.id, name: ev.name, args: ev.args });
          yield { type: "tool_call", id: ev.id, name: ev.name, args: ev.args };
          continue;
        }
        if (ev.type === "turn_done") { stop = ev.stop; usage = ev.usage; continue; }
        failure = { message: ev.message, aborted: ev.aborted };
      }

      // Whatever the model managed to say before the cut is part of the
      // conversation: barge-in must not erase the half of the answer the user heard.
      const assistant = assistantMessage(text, calls);
      if (text || calls.length) messages.push(assistant);
      if (usage) anchor = { index: messages.length - 1, tokens: usage.input + usage.output };

      if (failure || signal.aborted) {
        const aborted = failure?.aborted || signal.aborted;
        yield { type: "error", message: failure?.message ?? "Cancelled.", aborted };
        yield { type: "done", reason: aborted ? "aborted" : "error" };
        return;
      }

      yield { type: "turn_end", stop, usage };

      if (!calls.length) {
        await raceAbort(Promise.resolve(run.onTurnEnd?.(assistant)), signal);
        yield { type: "done", reason: "no_tools" };
        return;
      }

      let terminate = true;
      if (stop === "length") {
        for (const c of calls) {
          messages.push({ role: "tool", callId: c.id, name: c.name, result: TRUNCATED, isError: true });
          yield { type: "tool_result", id: c.id, name: c.name, content: [{ type: "text", text: TRUNCATED }], isError: true, details: { error: TRUNCATED } };
        }
        terminate = false;
      } else {
        const running = dispatch(calls, tools, { signal, context, insert: run.insert, clipboard: run.clipboard }, { approve, parallel: run.parallel });
        for (;;) {
          const next = await running.next();
          if (next.done) {
            for (const r of next.value) {
              const images = r.content.filter((c) => c.type === "image").map((c) => ({ data: c.data, mime: c.mime }));
              messages.push({ role: "tool", callId: r.id, name: r.name, result: asText(r.content), isError: r.isError, images: images.length ? images : undefined });
              if (!r.terminate) terminate = false;
            }
            break;
          }
          const r = next.value;
          yield { type: "tool_result", id: r.id, name: r.name, content: r.content, isError: r.isError, details: r.details };
        }
      }

      await raceAbort(Promise.resolve(run.onTurnEnd?.(assistant)), signal);
      if (terminate) { yield { type: "done", reason: "terminate" }; return; }
      if (await run.shouldStop?.()) { yield { type: "done", reason: "host_stop" }; return; }
    }
  } finally {
    for (const c of open) if (c.name === "insert_text") await run.insert.end(c.id);
  }
}
