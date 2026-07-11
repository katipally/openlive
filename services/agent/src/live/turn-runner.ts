import { streamProvider, isReasoningModel, type Message, type Effort } from "@openlive/harness";
import { buildTaktTools, type TaktTool, type Emit } from "../tools.js";
import { collectTurn } from "../turn.js";
import { buildLivePrompt } from "../prompt.js";
import { resolveLive, resolveVision, type ResolvedLive } from "../providers.js";
import { runWorker } from "./worker.js";

type Frame = { data: string; mime: string; source?: "camera" | "screen" };

/** Have the dedicated vision model look at the frames and report what's there, so
 *  a text-only live model can still "see". One extra round-trip — only taken when
 *  the user has configured a vision model. Returns "" on failure (caller falls
 *  back to attaching the frames to the live model directly). */
async function describeFrames(v: ResolvedLive, userText: string, frames: Frame[], sources: string, signal: AbortSignal): Promise<string> {
  const messages: Message[] = [
    { role: "system", text: `You are the eyes of a voice assistant. In 1-3 tight sentences, state exactly what is visible in the user's ${sources} right now — objects, on-screen text, layout, what the person is doing. No preamble, no "the image". If it's blank or unreadable, say so plainly.` },
    { role: "user", text: userText ? `The user said: "${userText}". What's visible?` : "What's visible right now?", images: frames.map((f) => ({ data: f.data, mime: f.mime })) },
  ];
  const turn = await collectTurn(
    streamProvider(v.provider, v.apiKey ?? undefined, { model: v.model, messages, tools: [], maxTokens: 512 }, signal),
    () => {}, // its text is not spoken; we fold the description into the live turn
  );
  return turn.text.trim();
}

/** Parse streamed tool-arg JSON; tolerate an empty/blank string. */
function safeParseArgs(s: string): any {
  const t = (s ?? "").trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

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

  /** Prime the provider's prompt cache (system + tools) with a tiny request the
   *  moment the session opens, so the FIRST real user turn is a cache HIT instead of
   *  a cold prefill (the biggest first-token latency lever — see anthropic.ts). Best
   *  effort: if it fails the first turn just pays the normal cold price. */
  async warm(signal: AbortSignal): Promise<void> {
    let resolved;
    try { resolved = resolveLive(); } catch { return; }
    const { provider, model, apiKey } = resolved;
    if (!model || (!apiKey && !provider.keyless)) return;
    const tools = [...buildTaktTools({ emit: async () => {} }), ...this.extraTools].filter((t) => !LIVE_TOOL_DENY.has(t.name));
    const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    try {
      // maxTokens:1 — we only want the prefill (cache write); the output is discarded.
      const gen = streamProvider(provider, apiKey ?? undefined, { model, messages: this.messages, tools: toolDefs, maxTokens: 1 }, signal);
      for await (const ev of gen) { void ev; if (signal.aborted) break; }
    } catch { /* cold first turn is the fallback */ }
  }

  // Bound the per-call history so a long conversation doesn't grow `messages`
  // unboundedly (Anthropic caching helps but doesn't cap it, and OpenAI has no cache
  // on this path). Cut only at a USER boundary so an assistant tool_use is never
  // separated from its tool_result (providers 400 on an orphaned pair).
  private capHistory() {
    const CAP = 40, KEEP = 30;
    if (this.messages.length <= CAP) return;
    let cut = this.messages.length - KEEP;
    while (cut < this.messages.length && this.messages[cut]!.role !== "user") cut++;
    if (cut > 1 && cut < this.messages.length) this.messages.splice(1, cut - 1);
  }

  async runTurn(userText: string, frames: { data: string; mime: string; source?: "camera" | "screen" }[], emit: Emit, signal: AbortSignal): Promise<void> {
    const { provider, model, apiKey, effort } = resolveLive();
    if (!model) { await emit({ type: "error", message: "No model selected. Open Settings and pick a provider + model." }); return; }
    if (!apiKey && !provider.keyless) { await emit({ type: "error", message: `No API key for ${provider.name}. Add one in Settings.` }); return; }
    // Attach frames from any active visual source (camera and/or screen — both can
    // be on). We do NOT gate on a hardcoded vision list: the frames go to whatever
    // model is picked, and if the provider genuinely can't take images it surfaces
    // a real error (never a faked "I can see"). Tell the model which source it is.
    let text = userText;
    let imgs: { data: string; mime: string }[] | undefined;
    if (frames.length) {
      const sources = [...new Set(frames.map((f) => f.source ?? "camera"))].join(" and ");
      // If the user configured a separate vision model, let IT see and fold its
      // description into this turn (so a text-only live model still works). Falls
      // back to attaching the frames to the live model if the describe call fails.
      const vision = resolveVision();
      let described = "";
      if (vision && vision.model !== model) {
        try { described = await describeFrames(vision, userText, frames, sources, signal); } catch { /* fall back to frames */ }
        if (signal.aborted) return;
      }
      if (described) {
        text = `${userText}\n\n[A vision model is looking at the user's ${sources} live right now and reports: ${described}\nTalk about what's actually there, naturally — as what you're both looking at. Don't mention "the image" or that another model described it.]`;
      } else {
        text = `${userText}\n\n[You're viewing the user's ${sources} live right now — talk about what's actually there, not "the image". If you truly can't make it out or got no picture, say so plainly and never invent details.]`;
        imgs = frames.map((f) => ({ data: f.data, mime: f.mime }));
      }
    }
    this.messages.push({ role: "user", text, images: imgs });
    // Keep frames only on the 2 most recent user turns (cost + latency).
    const withImgs = this.messages.filter((m) => m.role === "user" && m.images?.length);
    for (const m of withImgs.slice(0, -2)) if (m.role === "user") m.images = undefined;

    // Build tools with THIS turn's emit + signal so their events are dropped by the
    // same epoch guard when a barge-in interrupts. `runWorker` powers `delegate`.
    const tools = [...buildTaktTools({ emit, signal, runWorker }), ...this.extraTools]
      .filter((t) => !LIVE_TOOL_DENY.has(t.name));
    const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

    // Live wants the SNAPPIEST conversation. Auto = thinking OFF for an instant
    // reply — OpenAI can't fully disable it so we ask for "minimal"; Anthropic just
    // omits the thinking block (no reasoning). A user override in Settings raises it.
    // (MiniMax's reasoning is always-on and ignores this — see anthropic.ts.)
    const reasons = isReasoningModel(model);
    const reasoning = !reasons ? {}
      : effort ? (provider.protocol === "openai" ? { reasoningEffort: effort as string } : { effort: effort as Effort })
        : provider.protocol === "openai" ? { reasoningEffort: "minimal" as const }
          : {};

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
        // Run this step's tool calls CONCURRENTLY. Serializing them was extra dead
        // air (two web_searches back-to-back); fanned out, they finish while the
        // model's spoken bridge line is still being voiced. Results are pushed in
        // the original call order (providers pair each result to its call by id).
        const runOne = async (tc: (typeof turn.toolCalls)[number]) => {
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) return { tc, res: { output: `Unknown tool "${tc.name}".`, isError: true as const } };
          try { return { tc, res: await tool.execute(safeParseArgs(tc.arguments)) }; }
          catch (e: any) { return { tc, res: { output: `Error: ${String(e?.message ?? e)}`, isError: true as const } }; }
        };
        const results = await Promise.all(turn.toolCalls.map(runOne));
        if (signal.aborted) return;
        for (const { tc, res } of results) {
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
    this.capHistory();
  }
}
