import { streamProvider, isReasoningModel, type Message } from "@openlive/harness";
import { buildWorkerTools, type Emit } from "../tools.js";
import { collectTurn } from "../turn.js";
import { WORKER_PROMPT } from "../prompt.js";
import { resolveLive } from "../providers.js";

/** Parse streamed tool-arg JSON; tolerate an empty/blank string. */
function safeParseArgs(s: string): any {
  const t = (s ?? "").trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

// Only narrate once a step is ACTUALLY slow — under this it lands with the answer
// and a spoken bridge would just be chatter.
const NARRATE_AFTER_MS = 1500;
const MAX_NARRATIONS = 2;

// A short, natural spoken line built from what the worker is genuinely doing right
// now — the real query / page, not filler — so the voice fills a long tool wait
// with something true. Returns null when there's nothing worth saying.
function narrationFor(toolCalls: { name: string; arguments: string }[], count: number): string | null {
  const search = toolCalls.find((t) => t.name === "web_search");
  const fetch = toolCalls.find((t) => t.name === "fetch_url");
  if (search) {
    const q = String(safeParseArgs(search.arguments)?.query ?? "").split(/\s+/).slice(0, 7).join(" ").trim();
    if (!q) return null;
    return count === 0 ? ` Still searching for ${q}.` : ` Give me one more sec on ${q}.`;
  }
  if (fetch) {
    let host = "";
    try { host = new URL(String(safeParseArgs(fetch.arguments)?.url ?? "")).hostname.replace(/^www\./, ""); } catch { /* skip */ }
    return host ? ` Reading through ${host} now.` : null;
  }
  return null;
}

// The worker keeps its multi-step tool grind out of the main conversation, so the
// main agent's context stays small and its non-tool turns stay sub-1s. Bounded
// tight: every extra round here is time the user waits.
const WORKER_MAX_STEPS = 5;

/** Run a delegated task on a fresh subagent that owns the web tools. Its TOOL
 *  activity streams to `emit` (so the UI shows it working); its text is NEVER
 *  spoken — only the final findings string is returned for the main agent to say. */
export async function runWorker(task: string, emit: Emit, signal: AbortSignal): Promise<string> {
  const { provider, model, apiKey } = resolveLive();
  if (!model || (!apiKey && !provider.keyless)) return "(no model configured for the lookup)";

  const tools = buildWorkerTools({ emit });
  const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages: Message[] = [
    { role: "system", text: WORKER_PROMPT },
    { role: "user", text: task },
  ];
  // Worker reasons as little as possible — we want its tool results, fast.
  const reasoning = isReasoningModel(model) && provider.protocol === "openai" ? { reasoningEffort: "minimal" as const } : {};
  let narrations = 0;

  for (let step = 0; step < WORKER_MAX_STEPS; step++) {
    if (signal.aborted) return "(cancelled)";
    const turn = await collectTurn(
      streamProvider(provider, apiKey ?? undefined, { model, messages, tools: toolDefs, ...reasoning, maxTokens: 1024 }, signal),
      () => {}, // worker's own text is not spoken; discard its deltas
    );
    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined });
    if (!turn.toolCalls.length) return turn.text.trim() || "(no findings)";

    // If this step's tools take a while, speak ONE true line about what's happening
    // (the real query/page) so the main voice isn't dead-silent while we work.
    let narrateTimer: ReturnType<typeof setTimeout> | undefined;
    if (narrations < MAX_NARRATIONS) {
      const line = narrationFor(turn.toolCalls, narrations);
      if (line) narrateTimer = setTimeout(() => { if (!signal.aborted) { narrations++; void emit({ type: "text_delta", text: line }); } }, NARRATE_AFTER_MS);
    }
    const results = await Promise.all(turn.toolCalls.map(async (tc) => {
      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) return { tc, out: `Unknown tool "${tc.name}".` };
      try { return { tc, out: (await tool.execute(safeParseArgs(tc.arguments))).output }; }
      catch (e: any) { return { tc, out: `Error: ${String(e?.message ?? e)}` }; }
    }));
    if (narrateTimer) clearTimeout(narrateTimer);
    if (signal.aborted) return "(cancelled)";
    for (const { tc, out } of results) messages.push({ role: "tool", callId: tc.id, name: tc.name, result: out });
  }
  return "(couldn't pin it down in a few steps — tell the user you came up short)";
}
