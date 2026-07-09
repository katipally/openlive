// Server-only. The live turn logic that used to live in services/agent, ported
// into a serverless streaming route. Runs the multi-step tool loop against the
// chosen provider and emits SSE events. Stateless: the client sends the prior
// turns each call, so nothing persists server-side.
import {
  streamProvider, isReasoningModel, defaultModel,
  type ProviderEvent, type ToolCall, type Message, type Effort, type ProviderInfo,
} from "@openlive/harness";
import { modelVision, liveRecsFor, type SseEvent } from "@openlive/shared";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Emit = (e: SseEvent) => void;
type Frame = { data: string; mime: string };
type HistoryTurn = { role: "user" | "assistant"; text: string };

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any) => Promise<{ output: string; images?: Frame[]; isError?: boolean }>;
}

// ── system prompt ───────────────────────────────────────────────────────────
const PERSONA = `You are OpenLive, a capable, easygoing assistant — good at explaining things, reasoning, and handling whatever comes up. Talk like a real, helpful person, not a chatbot.

HOW YOU TALK
- Lead with the answer. No preamble, no restating their question, no "great question".
- A statement is a complete turn. You don't have to offer or ask something every time — end when the thought is done.
- Ask a question only when you genuinely can't proceed without it, and at most one.
- If they already said yes / go ahead, just do it — don't re-offer or re-confirm.
- Say each thing once. Vary your wording — never open two turns in a row the same way.
- Relaxed and human: contractions, a natural "yeah / honestly / got it" when it fits. Never forced, never fake enthusiasm.`;

const LIVE_RULES = `---
YOU ARE IN LIVE VOICE MODE — a real spoken conversation. Every word is read aloud by a text-to-speech voice.

HOW YOU TALK OUT LOUD
- 1–2 short spoken sentences. No lists, bullets, markdown, or symbols — they sound broken. Say numbers plainly ("about twenty").
- A spoken statement is a complete turn. Don't end every turn with an offer or question — only ask when you truly need the answer.
- Say the single most useful thing; if there's more, they'll ask. Don't re-say what you already told them.
- Speech-to-text mangles words; read charitably and confirm a likely mishear in a few words only if it would change the answer.

CAMERA — you are WATCHING their camera LIVE, like a video call, not looking at a photo.
- React to what's there right now, like a person: "yeah, I can see the bottle you're holding", "tilt it toward me a bit". Talk about what's actually there.
- NEVER say "the image", "the photo", "the picture", "the frame". Just say what you see ("I can see…", "looks like…").
- Need a closer look? Call \`look\`. Camera off and you need to see? Ask them to turn it on.

TOOLS
- Reach for a tool only when it genuinely helps: \`fetch_url\` to read a web page they mention, \`look\` for the camera, \`update_todos\` for a multi-step task. Most turns need no tools — just talk.`;

function buildLivePrompt(): string {
  return `${PERSONA}\n\n${LIVE_RULES}`;
}

// ── tools ───────────────────────────────────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 127 || p[0] === 10 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168);
}
async function hostIsPrivate(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return isPrivateIp(hostname);
  if (/^(localhost|.*\.local)$/i.test(hostname)) return true;
  try { const { address } = await dnsLookup(hostname); return isPrivateIp(address); }
  catch { return true; }
}

function buildTools(emit: Emit, frame: Frame | undefined, cameraOn: boolean): Tool[] {
  const text = (t: string) => ({ output: t });
  const updateTodos: Tool = {
    name: "update_todos",
    description: "Publish/update a short checklist (3+ steps) shown in the UI; mark items done as you go. Skip for simple answers.",
    parameters: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text", "done"] } } }, required: ["items"] },
    execute: async (args) => {
      const items = Array.isArray(args?.items) ? args.items.map((i: any) => ({ text: String(i.text ?? ""), done: !!i.done })).filter((i: any) => i.text) : [];
      emit({ type: "todos", items });
      return text("Checklist updated.");
    },
  };
  const look: Tool = {
    name: "look",
    description: "See the user's camera right now. Use when you need to look at what they're showing you. Returns nothing if the camera is off.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (!cameraOn || !frame) return text("The camera is off, so I can't see anything right now. Ask the user to turn on their camera.");
      return { output: "This is what the user's camera is showing right now — talk about it naturally, as what you're both looking at.", images: [frame] };
    },
  };
  const fetchUrl: Tool = {
    name: "fetch_url",
    description: "Fetch a public web page and return its readable text. Use when the user asks about a specific URL.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The absolute http(s) URL to fetch" } }, required: ["url"] },
    execute: async (args) => {
      const id = Math.random().toString(36).slice(2);
      const raw = String(args?.url ?? "").trim();
      emit({ type: "tool_start", id, tool: "fetch_url", summary: raw });
      let url: URL;
      try { url = new URL(raw); } catch { emit({ type: "tool_done", id, detail: "bad url" }); return text(`"${raw}" is not a valid URL.`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") { emit({ type: "tool_done", id, detail: "blocked" }); return text("Only http(s) URLs are allowed."); }
      if (await hostIsPrivate(url.hostname)) { emit({ type: "tool_done", id, detail: "blocked" }); return text("That host is not allowed (private/loopback/metadata address)."); }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual", headers: { "user-agent": "OpenLiveBot/1.0" } });
        if (res.status >= 300 && res.status < 400) { emit({ type: "tool_done", id, detail: "redirect" }); return text("The URL redirected; pass the final URL directly."); }
        if (!res.ok) { emit({ type: "tool_done", id, detail: `HTTP ${res.status}` }); return text(`Fetch failed: HTTP ${res.status}.`); }
        const body = htmlToText(await res.text()).slice(0, 20_000);
        emit({ type: "tool_done", id, detail: `${body.length} chars` });
        return text(body || "(no readable text found)");
      } catch (e: any) { emit({ type: "tool_done", id, detail: "error" }); return text(`Could not fetch: ${String(e?.message ?? e)}`); }
    },
  };
  return [fetchUrl, look, updateTodos];
}

// ── collectTurn (fold a provider stream into one assistant turn) ─────────────
function safeParseArgs(s: string): any {
  const t = (s ?? "").trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

async function collectTurn(gen: AsyncGenerator<ProviderEvent>, emit: Emit) {
  let textAcc = "", reasoning = "", reasoningSignature: string | undefined;
  const usage = { input: 0, output: 0 };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const ev of gen) {
    switch (ev.type) {
      case "text": {
        let d = ev.delta;
        if (textAcc.length === 0) { d = d.replace(/^\s+/, ""); if (!d) break; }
        textAcc += d; emit({ type: "text_delta", text: d }); break;
      }
      case "reasoning": reasoning += ev.delta; emit({ type: "reasoning_delta", text: ev.delta }); break;
      case "reasoning_signature": reasoningSignature = ev.signature; break;
      case "tool_start": calls.set(ev.index, { id: ev.id, name: ev.name, args: "" }); break;
      case "tool_delta": { const c = calls.get(ev.index); if (c) c.args += ev.argsDelta; break; }
      case "usage": usage.input += ev.input; usage.output += ev.output; break;
    }
  }
  const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args }));
  return { text: textAcc, reasoning, reasoningSignature, toolCalls, usage };
}

const MAX_STEPS = 6;

export async function runLiveTurn(opts: {
  provider: ProviderInfo; model: string; apiKey?: string; effort?: Effort;
  history: HistoryTurn[]; text: string; frame?: Frame; cameraOn: boolean;
  emit: Emit; signal: AbortSignal;
}): Promise<void> {
  const { provider, apiKey, effort, emit, signal } = opts;
  const model = opts.model || liveRecsFor(provider.id).find((r) => r.default)?.model || liveRecsFor(provider.id)[0]?.model || defaultModel(provider.id);
  if (!model) { emit({ type: "error", message: "No model selected. Open Settings and pick a model." }); return; }
  if (!apiKey && !provider.keyless) { emit({ type: "error", message: `No API key for ${provider.name}. Add one in Settings.` }); return; }

  const messages: Message[] = [{ role: "system", text: buildLivePrompt() }];
  for (const h of opts.history) if (h.text?.trim()) messages.push({ role: h.role, text: h.text });
  const canSee = modelVision(provider.id, model);
  const imgs = canSee && opts.frame ? [opts.frame] : undefined;
  messages.push({ role: "user", text: opts.text, images: imgs });

  const tools = buildTools(emit, opts.frame, opts.cameraOn);
  const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

  // Auto = lowest reasoning the model supports (minimal on OpenAI, low elsewhere);
  // a user override raises it.
  const reasons = isReasoningModel(model);
  const reasoning = !reasons ? {}
    : effort ? (provider.protocol === "openai" ? { reasoningEffort: effort as string } : { effort: effort as Effort })
      : provider.protocol === "openai" ? { reasoningEffort: "minimal" as const }
        : { effort: "low" as const };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;
      const turn = await collectTurn(
        streamProvider(provider, apiKey ?? undefined, { model, messages, tools: toolDefs, ...reasoning, maxTokens: 4096 }, signal),
        emit,
      );
      messages.push({
        role: "assistant", text: turn.text,
        reasoning: turn.reasoning || undefined, reasoningSignature: turn.reasoningSignature,
        toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
      });
      emit({ type: "usage", contextTokens: turn.usage.input, outputTokens: turn.usage.output, costUsd: 0 });
      if (!turn.toolCalls.length) break;
      for (const tc of turn.toolCalls) {
        if (signal.aborted) return;
        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) { messages.push({ role: "tool", callId: tc.id, name: tc.name, result: `Unknown tool "${tc.name}".`, isError: true }); continue; }
        let res;
        try { res = await tool.execute(safeParseArgs(tc.arguments)); }
        catch (e: any) { res = { output: `Error: ${String(e?.message ?? e)}`, isError: true as const }; }
        messages.push({ role: "tool", callId: tc.id, name: tc.name, result: res.output, images: res.images, isError: res.isError });
      }
    }
  } catch (e: any) {
    if (signal.aborted) return;
    const raw = String(e?.message ?? e);
    const msg = /quota|insufficient|billing/i.test(raw)
      ? `${provider.name}: API quota exhausted — add billing, or pick a different model.`
      : /invalid api key|authentication|401|403|unauthor|x-api-key|forbidden/i.test(raw)
        ? `${provider.name} rejected the API key — update it in Settings.`
        : `Live model error: ${raw}`;
    emit({ type: "error", message: msg });
  }
}
