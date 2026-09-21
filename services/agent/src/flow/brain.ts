import { streamProvider, type ProviderEvent } from "@openlive/harness";
import type { SseEvent } from "@openlive/shared";
import { readFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { getProviderKey, providerInfo, resolveLive, type ResolvedLive } from "../providers.js";
import type { Agent, TurnInput } from "../agents/types.js";
import { parsePartialJson } from "./partial-json.js";
import type { Brain, BrainEvent, TurnRequest, Usage } from "./types.js";

// ── provider mapping ────────────────────────────────────────────────────────

function mapStop(stopReason: string, sawTools: boolean): "stop" | "tools" | "length" {
  if (stopReason === "max_tokens" || stopReason === "length") return "length";
  if (sawTools) return "tools";
  return "stop";
}

/**
 * Fold the provider's event stream into Flow's six events.
 *
 * Stateful only in the way the wire is: tool calls arrive as an index-keyed
 * start / arg-fragment / stop triple, so the accumulated JSON per index lives
 * here. Reasoning is dropped: Flow speaks its replies, and a thinking channel
 * read aloud is noise.
 */
export function createProviderMapper(): (ev: ProviderEvent) => BrainEvent[] {
  const calls = new Map<number, { id: string; name: string; raw: string }>();
  const usage: Usage = { input: 0, output: 0 };
  let sawTools = false;

  return (ev) => {
    switch (ev.type) {
      case "text":
        return ev.delta ? [{ type: "text_delta", delta: ev.delta }] : [];
      case "tool_start":
        calls.set(ev.index, { id: ev.id, name: ev.name, raw: "" });
        sawTools = true;
        return [{ type: "tool_start", id: ev.id, name: ev.name }];
      case "tool_delta": {
        const c = calls.get(ev.index);
        if (!c) return [];
        c.raw += ev.argsDelta;
        return [{ type: "tool_args_delta", id: c.id, argsPartial: parsePartialJson(c.raw) }];
      }
      case "tool_stop": {
        const c = calls.get(ev.index);
        if (!c) return [];
        return [{ type: "tool_end", id: c.id, name: c.name, args: parsePartialJson(c.raw) }];
      }
      case "usage":
        usage.input += ev.input;
        usage.output += ev.output;
        return [];
      case "done":
        return [{ type: "turn_done", stop: mapStop(ev.stopReason, sawTools), usage: { ...usage } }];
      default:
        return [];
    }
  };
}

const message = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 400) || "the model stream failed";
};

/**
 * Flow's brain choice is an override on the shared resolution, never a second
 * copy of it: an unset, unknown or unkeyed pick falls straight through to what
 * live voice already resolved.
 */
export function resolveFlowBrain(cfg: FlowConfig = readFlowConfig(), base: ResolvedLive = resolveLive()): ResolvedLive {
  const provider = cfg.brain.providerId ? providerInfo(cfg.brain.providerId) : undefined;
  if (!provider) return cfg.brain.model ? { ...base, model: cfg.brain.model } : base;
  const apiKey = getProviderKey(provider.id);
  if (!apiKey && !provider.keyless) return base;
  return { provider, model: cfg.brain.model || base.model, apiKey, effort: base.effort };
}

/** The built-in brain: OpenLive's own provider resolution, keys and adapters. */
export class LocalBrain implements Brain {
  readonly id = "local";
  constructor(private readonly resolve: () => ResolvedLive = () => resolveFlowBrain()) {}

  async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<BrainEvent> {
    let sawDone = false;
    try {
      const { provider, model, apiKey, effort } = this.resolve();
      const messages = [{ role: "system" as const, text: req.systemPrompt }, ...req.messages];
      const gen = streamProvider(provider, apiKey ?? undefined, { model, messages, tools: req.tools, effort }, signal);
      const map = createProviderMapper();
      for await (const ev of gen) {
        for (const out of map(ev)) {
          if (out.type === "turn_done") sawDone = true;
          yield out;
        }
      }
      if (!sawDone) yield { type: "turn_done", stop: "stop" };
    } catch (e) {
      yield { type: "turn_error", message: message(e), aborted: signal.aborted };
    }
  }
}

// ── ACP mapping ─────────────────────────────────────────────────────────────

/**
 * Request direction: an ACP agent owns its own model, prompt and tools, so all
 * it takes from the turn is what the user just said. History reaches it through
 * `Agent.seed`, and its own tool calls are its business, not the loop's.
 */
export function acpTurnInput(req: TurnRequest): TurnInput {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === "user") return { text: m.text, frames: [] };
  }
  return { text: "", frames: [] };
}

/**
 * Event direction. The agent's own tool activity is NOT mapped to `tool_start` /
 * `tool_end`: those mean "the loop must execute this", and an ACP agent has
 * already run its tools itself. Flow's tool set reaches an ACP brain as MCP.
 */
export function acpEventToBrain(e: SseEvent): BrainEvent | null {
  if (e.type === "text_delta") return { type: "text_delta", delta: e.text };
  if (e.type === "error") return { type: "turn_error", message: e.message, aborted: false };
  return null;
}

/** Hand events from a callback API to an async iterator, oldest first. */
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const bump = () => { const w = wake; wake = null; w?.(); };
  return {
    push(v: T) { queue.push(v); bump(); },
    close() { closed = true; bump(); },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
}

/** A coding agent over ACP, driven as the Flow brain. */
export class AcpBrain implements Brain {
  readonly id: string;
  constructor(private readonly agent: Agent) { this.id = agent.id; }

  async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<BrainEvent> {
    const ch = channel<BrainEvent>();
    let usage: Usage | undefined;
    let failed = false;
    const run = this.agent
      .runTurn(acpTurnInput(req), (e) => {
        if (e.type === "usage") { usage = { input: e.contextTokens, output: e.outputTokens ?? 0 }; return; }
        const ev = acpEventToBrain(e);
        if (!ev) return;
        if (ev.type === "turn_error") failed = true;
        ch.push(ev);
      }, signal)
      .catch((e: unknown) => { failed = true; ch.push({ type: "turn_error", message: message(e), aborted: signal.aborted }); })
      .finally(() => ch.close());

    for await (const ev of ch.drain()) yield ev;
    await run;
    if (!failed) yield { type: "turn_done", stop: "stop", usage };
  }
}
