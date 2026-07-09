import { streamProvider, isReasoningModel, type Message, type Effort } from "@openlive/harness";
import { modelVision } from "@openlive/shared";
import { buildTaktTools, type TaktTool, type Emit } from "../tools.js";
import { collectTurn } from "../turn.js";
import { safeParseArgs } from "../turn-loop.js";
import { buildLivePrompt } from "../prompt.js";
import { resolveLive } from "../providers.js";

// Lower than a text chat's step cap ON PURPOSE. Every tool round before the model
// speaks is dead air in a live call, so cap the worst case tightly.
const MAX_STEPS = 6;

// Tools that don't belong in a spoken call. (None generic — `look` is added by the
// session; blocking tools are simply not registered.)
const LIVE_TOOL_DENY = new Set<string>([]);

// A per-call LLM driver that keeps a growing Message[] across turns and injects the
// camera frame(s) onto each user turn.
export class LiveTurnRunner {
  private messages: Message[];

  constructor(private extraTools: TaktTool[]) {
    this.messages = [{ role: "system", text: buildLivePrompt() }];
  }

  /** Seed prior conversation (text only) after the system prompt — used on
   *  reconnect so the agent doesn't forget what was already said in the call. */
  seed(history: Message[]) {
    this.messages.splice(1, this.messages.length - 1, ...history);
  }

  async runTurn(userText: string, frames: { data: string; mime: string; source?: "camera" | "screen" }[], emit: Emit, signal: AbortSignal): Promise<void> {
    const { provider, model, apiKey, effort } = resolveLive();
    if (!model) { await emit({ type: "error", message: "No model selected. Open Settings and pick a provider + model." }); return; }
    if (!apiKey && !provider.keyless) { await emit({ type: "error", message: `No API key for ${provider.name}. Add one in Settings.` }); return; }
    // Only attach frames if the live model can actually see. Tell the model whether
    // it's looking at a camera or a screen (both can be on at once).
    const canSee = modelVision(provider.id, model);
    let text = userText;
    if (frames.length) {
      const sources = [...new Set(frames.map((f) => f.source ?? "camera"))].join(" and ");
      text = canSee
        ? `${userText}\n\n[You're viewing the user's ${sources} live right now — react to what's actually there.]`
        : `${userText}\n\n[The user is sharing their ${sources}, but this model can't see images. Tell them to switch to a vision model like Claude Haiku 4.5 or GPT-5 mini in Settings.]`;
    }
    const imgs = canSee && frames.length ? frames.map((f) => ({ data: f.data, mime: f.mime })) : undefined;
    this.messages.push({ role: "user", text, images: imgs });
    // Keep frames only on the 2 most recent user turns (cost + latency).
    const withImgs = this.messages.filter((m) => m.role === "user" && m.images?.length);
    for (const m of withImgs.slice(0, -2)) if (m.role === "user") m.images = undefined;

    // Build tools with THIS turn's emit so their events are dropped by the same
    // epoch guard when a barge-in interrupts.
    const tools = [...buildTaktTools({ emit }), ...this.extraTools]
      .filter((t) => !LIVE_TOOL_DENY.has(t.name));
    const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

    // Live wants the SMOOTHEST conversation. Auto = lowest reasoning the model
    // supports (minimal on OpenAI, low elsewhere); a user override raises it.
    const reasons = isReasoningModel(model);
    const reasoning = !reasons ? {}
      : effort ? (provider.protocol === "openai" ? { reasoningEffort: effort as string } : { effort: effort as Effort })
        : provider.protocol === "openai" ? { reasoningEffort: "minimal" as const }
          : { effort: "low" as const };

    // Track assistant text AS it streams, so a barge-in that aborts mid-sentence
    // doesn't lose what we'd started saying.
    let partial = "";
    const track: Emit = (e) => { if (e.type === "text_delta") partial += e.text; return emit(e); };

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) return;
        partial = "";
        const turn = await collectTurn(
          streamProvider(provider, apiKey ?? undefined, { model, messages: this.messages, tools: toolDefs, ...reasoning, maxTokens: 4096 }, signal),
          track,
        );
        this.messages.push({
          role: "assistant",
          text: turn.text,
          reasoning: turn.reasoning || undefined,
          reasoningSignature: turn.reasoningSignature,
          toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
        });
        await emit({ type: "usage", contextTokens: turn.usage.input, outputTokens: turn.usage.output, costUsd: 0 });
        if (!turn.toolCalls.length) break;
        for (const tc of turn.toolCalls) {
          if (signal.aborted) return;
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) { this.messages.push({ role: "tool", callId: tc.id, name: tc.name, result: `Unknown tool "${tc.name}".`, isError: true }); continue; }
          let res;
          try { res = await tool.execute(safeParseArgs(tc.arguments)); }
          catch (e: any) { res = { output: `Error: ${String(e?.message ?? e)}`, isError: true as const }; }
          this.messages.push({ role: "tool", callId: tc.id, name: tc.name, result: res.output, images: res.images, isError: res.isError });
        }
      }
    } catch (e: any) {
      if (signal.aborted) {
        if (partial.trim()) this.messages.push({ role: "assistant", text: partial.trim() });
        return;
      }
      const raw = String(e?.message ?? e);
      const msg = /quota|insufficient|billing/i.test(raw)
        ? `${provider.name}: API quota exhausted — add billing, or pick a different model in Settings.`
        : /invalid api key|authentication|401|403|unauthor|x-api-key|forbidden/i.test(raw)
          ? `${provider.name} rejected the API key — update it in Settings.`
          : `Live model error: ${raw}`;
      await emit({ type: "error", message: msg });
    }
  }
}
