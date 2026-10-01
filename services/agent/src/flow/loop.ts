import { allContent, asMessage, asStateTail, dispatch, newestState, shownName, toolSpecs, type ToolCall, type ToolSet, type ToolTally, type Verdict } from "../capabilities/dispatch.js";
import { allowAll } from "../capabilities/approval.js";
import { READ_TOOL, USE_TOOL } from "../capabilities/on-demand.js";
import type { Approve, Session } from "../capabilities/types.js";
import { trimImages } from "./retention.js";
import { formatContext } from "./prompt.js";
import { CARRIED_HEAD, carriedSkills } from "../skills/content.js";
import type { ErrorClass } from "@openlive/shared";
import type { Brain, FlowEvent, Msg, Usage } from "./types.js";

// The only control flow in Flow. Two levels: turns, and the events inside a
// turn. It owns no budget and counts no steps: a run ends because the data said
// so (no tool calls, every tool asked to stop, the host said stop, an error, or
// the user talked over it), never because a constant ran out.

export interface FlowRun {
  brain: Brain;
  tools: ToolSet;
  /** The conversation. Appended to in place, so the host persists what it already holds. */
  messages: Msg[];
  signal: AbortSignal;
  /** What the tools reach. Its `foreground` is captured once a turn, and its
   *  `insert` takes insert_text's words as they stream. */
  session: Session;
  /** Resolved per turn. Must not throw. */
  getSystemPrompt: () => string | Promise<string>;
  approve?: Approve;
  /** False runs tools one at a time. Approval is sequential either way. */
  parallel?: boolean;
  /** Told of every call that ran. Must not throw. */
  tally?: ToolTally;
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
 * The cut never lands on a tool result: one whose assistant call was dropped is
 * a message no provider will accept. It may land mid-run, because one request
 * can take more steps than the tail holds, so the request itself rides along in
 * the note or the model loses sight of what it was asked to do. So do the
 * skills activated in what is dropped.
 */
export function compact(messages: Msg[], budget: Budget, anchor: { index: number; tokens: number } | null): Msg[] | null {
  if (estimateTokens(messages, anchor) <= budget.limit - budget.reserve) return null;
  let cut = Math.max(0, messages.length - budget.tail);
  while (cut < messages.length && messages[cut]!.role === "tool") cut++;
  if (cut === 0 || cut >= messages.length) return null;
  const carried = carriedSkills(messages.slice(0, cut), messages.slice(cut));
  const skills = carried && `\n\n${CARRIED_HEAD}\n${carried}`;
  if (messages[cut]!.role === "user") return [{ role: "user", text: TRIM_NOTE + skills }, ...messages.slice(cut)];
  let ask = cut - 1;
  while (ask >= 0 && messages[ask]!.role !== "user") ask--;
  // An earlier note's skills are among those carried, so only its request is kept from it.
  const asked = ask >= 0 ? (messages[ask] as { text: string }).text.split(`\n\n${CARRIED_HEAD}`)[0]! : "";
  // A note from an earlier compaction already carries the request.
  const note = !asked || asked.startsWith(TRIM_NOTE) ? asked || TRIM_NOTE : `${TRIM_NOTE}\n\nWhat they asked for:\n${asked}`;
  return [{ role: "user", text: note + skills }, ...messages.slice(cut)];
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

function assistantMessage(text: string, calls: ToolCall[], reasoning = "", reasoningSignature?: string): Msg {
  return {
    role: "assistant",
    text: text || undefined,
    reasoning: reasoning || undefined,
    reasoningSignature,
    toolCalls: calls.length ? calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) : undefined,
  };
}

// The salvage parser will happily hand back arguments that parse and validate
// while being silently half-written, so a truncated message poisons every call
// in it, not just the last one.
const TRUNCATED = "The model ran out of room mid-call, so the arguments may be incomplete. Nothing was run. Say it again more briefly.";

const alreadyTyped = (committed: string) =>
  `${TRUNCATED} The first ${committed.length} characters were already typed into the document; they will not be typed again.`;

// ── the loop ────────────────────────────────────────────────────────────────

export async function* runFlow(run: FlowRun): AsyncGenerator<FlowEvent> {
  const { brain, tools, messages, signal, session } = run;
  const insert = session.insert;
  const approve = run.approve ?? allowAll;
  const budget = run.budget ?? DEFAULT_BUDGET;
  const specs = toolSpecs(tools.list);
  let anchor: { index: number; tokens: number } | null = null;
  // The calls of the turn in flight. Any insertion they opened is closed on the
  // way out, whichever way the run ends.
  let open: ToolCall[] = [];

  try {
    for (;;) {
      if (signal.aborted) { yield { type: "error", message: "Cancelled.", aborted: true }; yield { type: "done", reason: "aborted" }; return; }

      for (const m of run.pollSteering?.() ?? []) messages.push(m);

      const context = (await session.foreground?.capture(signal)) ?? null;
      if (context) yield { type: "context", context };

      // The anchor's token count included the pictures just dropped.
      const trimmed = trimImages(messages);
      if (trimmed) { messages.splice(0, messages.length, ...trimmed); anchor = null; }

      const compacted = compact(messages, budget, anchor);
      if (compacted) { messages.splice(0, messages.length, ...compacted); anchor = null; }

      const systemPrompt = await run.getSystemPrompt();

      let text = "";
      let reasoning = "";
      let signature: string | undefined;
      const calls: ToolCall[] = [];
      /** read_tool and use_tool calls whose start waits for the tool they name. */
      const unnamed = new Set<string>();
      open = calls;
      // Resolved once per call, by whoever needs it first, and reused by dispatch.
      const preflighted = new Map<string, Promise<Verdict>>();
      let usage: Usage | undefined;
      let stop: "stop" | "tools" | "length" = "stop";
      let failure: { message: string; aborted: boolean; code?: ErrorClass } | null = null;

      /**
       * May this call's text go into the user's document as it arrives?
       *
       * Committing mid-stream is the one path from model output to an executed
       * action that dispatch does not stand in front of, so consent is checked
       * here instead, before the first character lands. Consent already given
       * answers in a microtask and the text streams as before.
       */
      const mayStream = async (call: ToolCall, args: Record<string, unknown>): Promise<boolean> => {
        let decision = preflighted.get(call.id);
        if (!decision) {
          const tool = tools.resolve(call.name);
          if (!tool) return false;
          decision = Promise.resolve(approve({ tool, args }, signal))
            .catch((e): Verdict => ({ block: true, reason: e instanceof Error ? e.message : "the approval failed" }));
          preflighted.set(call.id, decision);
        }
        return !(await decision).block;
      };

      const shown = newestState.get(messages);
      const said = [shown?.text, formatContext(context)].filter(Boolean).join("\n\n");
      const tail = said ? { text: said, ...(shown?.images && { images: shown.images }) } : undefined;

      for await (const ev of brain.stream({ systemPrompt, messages: [...messages], tools: specs, tail }, signal)) {
        if (ev.type === "text_delta") { text += ev.delta; yield { type: "text_delta", delta: ev.delta }; continue; }
        if (ev.type === "reasoning") { reasoning += ev.delta; continue; }
        if (ev.type === "reasoning_signature") { signature = ev.signature; continue; }
        if (ev.type === "tool_start") {
          calls.push({ id: ev.id, name: ev.name, args: {} });
          // Which connector tool read_tool or use_tool runs is only known once its arguments are in.
          const wrapper = !!tools.onDemand && [READ_TOOL, USE_TOOL].includes(tools.resolve(ev.name)?.name ?? "");
          if (wrapper) unnamed.add(ev.id); else yield { type: "tool_start", id: ev.id, name: ev.name };
          continue;
        }
        if (ev.type === "tool_args_delta") {
          yield { type: "tool_args_delta", id: ev.id, argsPartial: ev.argsPartial };
          // The insertion sink is forward-only, so handing it the growing text is
          // safe to do before the call is even finished being written.
          const call = calls.find((c) => c.id === ev.id);
          if (insert && call?.name === "insert_text" && typeof ev.argsPartial.text === "string" && await mayStream(call, ev.argsPartial)) {
            await insert.commit(ev.id, ev.argsPartial.text);
          }
          continue;
        }
        if (ev.type === "tool_end") {
          const call = calls.find((c) => c.id === ev.id);
          if (call) call.args = ev.args; else calls.push({ id: ev.id, name: ev.name, args: ev.args });
          const name = shownName({ id: ev.id, name: ev.name, args: ev.args }, tools);
          if (unnamed.delete(ev.id)) yield { type: "tool_start", id: ev.id, name };
          yield { type: "tool_call", id: ev.id, name, args: ev.args };
          continue;
        }
        if (ev.type === "turn_done") { stop = ev.stop; usage = ev.usage; continue; }
        failure = { message: ev.message, aborted: ev.aborted, code: ev.code };
      }

      // Whatever the model managed to say before the cut is part of the
      // conversation: barge-in must not erase the half of the answer the user heard.
      const assistant = assistantMessage(text, calls, reasoning, signature);
      if (text || calls.length) messages.push(assistant);
      if (usage) anchor = { index: messages.length - 1, tokens: usage.input + usage.output };

      if (failure || signal.aborted) {
        const aborted = failure?.aborted || signal.aborted;
        yield { type: "error", message: failure?.message ?? "Cancelled.", aborted, ...(failure?.code && { code: failure.code }) };
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
          const typed = insert?.committed(c.id) ?? "";
          if (typed) await insert!.abandon(c.id);
          const result = typed ? alreadyTyped(typed) : TRUNCATED;
          messages.push({ role: "tool", callId: c.id, name: c.name, result, isError: true });
          yield { type: "tool_result", id: c.id, name: c.name, content: [{ type: "text", text: result }], isError: true, details: { error: result } };
        }
        terminate = false;
      } else {
        const running = dispatch(calls, tools, { ...session, signal, context }, { approve, parallel: run.parallel, preflighted, tally: run.tally });
        for (;;) {
          const next = await running.next();
          if (next.done) {
            for (const r of next.value) {
              messages.push({ role: "tool", ...asMessage(r) });
              if (r.state) newestState.set(messages, asStateTail(r.name, r.state));
              if (!r.terminate) terminate = false;
            }
            break;
          }
          const r = next.value;
          yield { type: "tool_result", id: r.id, name: r.name, content: allContent(r), isError: r.isError, details: r.details };
        }
      }

      await raceAbort(Promise.resolve(run.onTurnEnd?.(assistant)), signal);
      if (terminate) { yield { type: "done", reason: "terminate" }; return; }
      if (await run.shouldStop?.()) { yield { type: "done", reason: "host_stop" }; return; }
    }
  } finally {
    for (const c of open) if (c.name === "insert_text") await insert?.abandon(c.id);
  }
}
