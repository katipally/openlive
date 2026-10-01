import { streamProvider, unreachableMessage, type Message, type ProviderInfo } from "@openlive/harness";
import { classifyError, type LanguageCode } from "@openlive/shared";
import type { Approve, Emit, Session } from "../capabilities/types.js";
import { asMessage, dispatchAll, toolSpecs, type ToolSet, type ToolTally } from "../capabilities/dispatch.js";
import { CHAT } from "../capabilities/profiles.js";
import { cancelledText, collectTurn, safeParseArgs, type Turn } from "../turn.js";
import { log } from "../log.js";
import { liveReasoning, resolveLive, resolveVision, type ResolvedLive } from "../providers.js";
import { prepareToolImages } from "../tool-images.js";
import { trimImages } from "../flow/retention.js";
import { CARRIED_HEAD, carriedSkills } from "../skills/content.js";

type Frame = { data: string; mime: string; source?: "camera" | "screen" | "attachment" };

/** Where the frames came from, as a note to the model reads it: "camera and screen", "attached image". */
export const frameSources = (frames: Frame[]): string =>
  [...new Set(frames.map((f) => (f.source === "attachment" ? "attached image" : f.source ?? "camera")))].join(" and ");

/** Have the dedicated vision model look at the frames and report what's there, so
 *  a text-only live model can still "see". One extra round-trip — only taken when
 *  the user has configured a vision model. Returns "" on failure (caller falls
 *  back to attaching the frames to the live model directly). */
export async function describeFrames(v: ResolvedLive, userText: string, frames: Frame[], sources: string, signal: AbortSignal): Promise<string> {
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

/** Each step streams its text on its own, so "On it." and the next step's "No
 *  workspace…" would run together wherever the turn is stored as one text. */
export const stepGap = (before: string, next: string): string =>
  before && next && !/\s$/.test(before) && !/^\s/.test(next) ? " " : "";

// Lower than a text chat's step cap ON PURPOSE. Every tool round before the model
// speaks is dead air in a live call, so cap the worst case tightly.
const MAX_STEPS = 6;

/** Said when the last, tool-free step still comes back without words. */
export const OUT_OF_STEPS = "I couldn't quite finish that one. Want me to keep going?";

/** A request with no tools is still valid here. Anthropic refuses tool_use
 *  blocks in a request that defines no tools; the OpenAI APIs take them. */
const canDropTools = (provider: Pick<ProviderInfo, "protocol">, messages: readonly Message[]) =>
  provider.protocol !== "anthropic" || !messages.some((m) => m.role === "assistant" && m.toolCalls?.length);

// A per-call LLM driver that keeps a growing Message[] across turns and injects the
// camera frame(s) onto each user turn.
export class LiveTurnRunner {
  private messages: Message[];
  /** What the vision model said about each tool's picture, by call id. */
  private described = new Map<string, string>();
  /** Always messages[0]: seeding and the history cap keep it. */
  private readonly system = { role: "system" as const, text: "" };

  /** `tools` is the call's set, run against `session` through `approve`; `tally` hears each call.
   *  The call swaps `tools` when its folder changes, as a folder brings its own skills. */
  constructor(public tools: ToolSet, private session: Session, private opts: { approve: Approve; tally?: ToolTally }) {
    this.messages = [this.system];
  }

  /** Seed prior conversation (text only) after the system prompt — used on
   *  reconnect so the agent doesn't forget what was already said in the call. */
  seed(history: Message[]) {
    this.messages.splice(1, this.messages.length - 1, ...history);
  }

  /** Prime the provider's prompt cache (system + tools) with a tiny request the
   *  moment the session opens, so the FIRST real user turn is a cache HIT instead of
   *  a cold prefill (the biggest first-token latency lever — see anthropic.ts). Best
   *  effort: if it fails the first turn just pays the normal cold price. `lang` is
   *  the language the client connected in, so a non-English first turn hits too. */
  async warm(signal: AbortSignal, lang?: LanguageCode): Promise<void> {
    let resolved;
    try { resolved = resolveLive(); } catch { return; }
    const { provider, model, apiKey } = resolved;
    if (!model || (!apiKey && !provider.keyless)) return;
    const toolDefs = toolSpecs(this.tools.list);
    this.system.text = CHAT.prompt(this.tools.list, lang);
    try {
      // maxTokens:1 — we only want the prefill (cache write); the output is discarded.
      const gen = streamProvider(provider, apiKey ?? undefined, { model, messages: this.messages, tools: toolDefs, maxTokens: 1 }, signal);
      for await (const ev of gen) { void ev; if (signal.aborted) break; }
    } catch { /* cold first turn is the fallback */ }
  }

  /** Keep only what the voice said of the latest reply, so the model never
   *  remembers saying what the user cut off before hearing. */
  truncateReply(spoken: string) {
    let from = this.messages.length;
    while (from > 1 && this.messages[from - 1]!.role !== "user") from--;
    if (from <= 1) return;
    let placed = false;
    for (let i = from; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (m.role !== "assistant") continue;
      m.text = placed ? undefined : spoken.trim() || undefined;
      placed = true;
    }
    for (let i = this.messages.length - 1; i >= from; i--) {
      const m = this.messages[i]!;
      if (m.role === "assistant" && !m.text && !m.toolCalls?.length) this.messages.splice(i, 1);
    }
  }

  // Bound the per-call history so a long conversation doesn't grow `messages`
  // unboundedly (Anthropic caching helps but doesn't cap it, and OpenAI has no cache
  // on this path). Cut only at a USER boundary so an assistant tool_use is never
  // separated from its tool_result (providers 400 on an orphaned pair). Skills
  // activated in what is cut stay, in a note where the cut was.
  private capHistory() {
    const CAP = 40, KEEP = 30;
    if (this.messages.length <= CAP) return;
    let cut = this.messages.length - KEEP;
    while (cut < this.messages.length && this.messages[cut]!.role !== "user") cut++;
    if (cut <= 1 || cut >= this.messages.length) return;
    const carried = carriedSkills(this.messages.slice(1, cut), this.messages.slice(cut));
    this.messages.splice(1, cut - 1, ...(carried ? [{ role: "user" as const, text: `[${CARRIED_HEAD}]\n${carried}` }] : []));
  }

  async runTurn(userText: string, frames: Frame[], emit: Emit, signal: AbortSignal, lang?: LanguageCode): Promise<void> {
    const live = resolveLive();
    const { provider, model, apiKey, effort } = live;
    if (!model) { await emit({ type: "error", message: "No model selected. Open Settings and pick a provider + model.", code: "no_model" }); return; }
    if (!apiKey && !provider.keyless) { await emit({ type: "error", message: `No API key for ${provider.name}. Add one in Settings.`, code: "no_key" }); return; }
    // Attach frames from any active visual source (camera and/or screen — both can
    // be on). We do NOT gate on a hardcoded vision list: the frames go to whatever
    // model is picked, and if the provider genuinely can't take images it surfaces
    // a real error (never a faked "I can see"). Tell the model which source it is.
    let text = userText;
    let imgs: { data: string; mime: string }[] | undefined;
    if (frames.length) {
      const sources = frameSources(frames);
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
    // Per turn, so a language change in the middle of a call applies from the next turn.
    this.system.text = CHAT.prompt(this.tools.list, lang);
    const asked = { role: "user" as const, text, images: imgs };
    this.messages.push(asked);
    // Keep frames only on the 2 most recent user turns (cost + latency).
    const withImgs = this.messages.filter((m) => m.role === "user" && m.images?.length);
    for (const m of withImgs.slice(0, -2)) if (m.role === "user") m.images = undefined;

    const toolDefs = toolSpecs(this.tools.list);

    // Live wants the SNAPPIEST conversation. Auto = thinking OFF for an instant
    // reply — OpenAI can't fully disable it so we ask for "minimal"; Anthropic just
    // omits the thinking block (no reasoning). A user override in Settings raises it.
    // (MiniMax's reasoning is always-on and ignores this — see anthropic.ts.)
    const reasoning = liveReasoning({ provider, model, apiKey, effort });

    // Track assistant text AS it streams, so a barge-in that aborts mid-sentence
    // doesn't lose what we'd started saying.
    let partial = "";
    let before = "";
    const track: Emit = (e) => {
      if (e.type !== "text_delta") return emit(e);
      const text = partial ? e.text : stepGap(before, e.text) + e.text;
      partial += text;
      return emit({ ...e, text });
    };

    try {
      // Once the tool budget is spent, one more step with tools forbidden, so the
      // turn always ends in a spoken reply instead of silence.
      for (let step = 0; step <= MAX_STEPS; step++) {
        if (signal.aborted) return;
        if (partial) before = partial;
        partial = "";
        // As in Flow: only the newest tool pictures show the screen as it is, and every picture kept is sent again each step.
        const trimmed = trimImages(this.messages);
        if (trimmed) this.messages.splice(0, this.messages.length, ...trimmed);
        const last = step === MAX_STEPS;
        const ask = async (bare: boolean) => collectTurn(
          streamProvider(provider, apiKey ?? undefined, { model, messages: await prepareToolImages(this.messages, live, signal, this.described), tools: bare ? [] : toolDefs, ...(last && !bare && { toolChoice: "none" as const }), ...reasoning, maxTokens: 4096 }, signal),
          track,
        );
        let turn: Turn | null;
        try { turn = await ask(false); }
        catch (e) {
          if (!last || signal.aborted || partial) throw e;
          // Perhaps a provider that refuses tool_choice "none": once more without tools, where that is a valid request.
          log.warn("live", "the last, tool-free step failed:", String((e as Error)?.message ?? e));
          turn = canDropTools(provider, this.messages) ? await ask(true).catch(() => null) : null;
          if (signal.aborted) return;
        }
        // A provider that ignores toolChoice may still call one; drop it, as it would never get a result.
        const toolCalls = last ? [] : turn!.toolCalls;
        // The turn always ends in words: a last step with none says so plainly.
        const said = turn?.text ?? partial;
        const silent = last && !said.trim();
        if (silent) await track({ type: "text_delta", text: OUT_OF_STEPS });
        this.messages.push({
          role: "assistant",
          text: silent ? OUT_OF_STEPS : said,
          reasoning: turn?.reasoning || undefined,
          reasoningSignature: turn?.reasoningSignature,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        });
        if (turn) await emit({ type: "usage", contextTokens: turn.usage.input, outputTokens: turn.usage.output, costUsd: 0 });
        if (!toolCalls.length) break;
        // Run this step's tool calls CONCURRENTLY. Serializing them was extra dead
        // air (two web_searches back-to-back); fanned out, they finish while the
        // model's spoken bridge line is still being voiced. A tool's events go to
        // THIS turn's emit, so a barge-in drops them with the rest of the turn.
        // Results come back in the original call order (providers pair each result
        // to its call by id), one for EVERY call, unconditionally, even on a
        // barge-in abort: an assistant message carrying toolCalls with no matching
        // results makes the very next turn 400 at Anthropic/OpenAI (orphaned
        // tool_use), poisoning the rest of the call.
        const calls = toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments) }));
        const results = await dispatchAll(calls, this.tools, { ...this.session, emit, signal, context: null }, this.opts);
        for (const r of results) this.messages.push({ role: "tool", ...asMessage(r) });
        if (signal.aborted) return;
      }
    } catch (e: any) {
      if (signal.aborted) {
        if (partial.trim()) this.messages.push({ role: "assistant", text: partial.trim() });
        return;
      }
      const raw = String(e?.message ?? e);
      const code = classifyError(e);
      const msg = code === "unreachable" ? unreachableMessage(provider)
        : code === "quota"
        ? `${provider.name}: API quota exhausted — add billing, or pick a different model in Settings.`
        : code === "auth"
          ? `${provider.name} rejected the API key — update it in Settings.`
          : `Live model error: ${raw}`;
      await emit({ type: "error", message: msg, code });
    } finally {
      if (signal.aborted) asked.text = cancelledText(asked.text);
    }
    this.capHistory();
  }
}
