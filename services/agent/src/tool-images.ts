import { catalogModels, providerAddress, streamProvider, type Message, type ProviderInfo } from "@openlive/harness";
import { modelVision } from "@openlive/shared";
import { collectTurn } from "./turn.js";
import { resolveVision, type ResolvedLive } from "./providers.js";

// A tool that shows the model the screen only helps a model that can see. This
// decides, per turn, what a picture in a tool result becomes: the picture itself,
// a description from the vision model set in Settings > Models, or a plain note
// that there was one and it was not sent, so a blind model never claims to see.

/** Answers already read, per provider address and model. Only definite ones are kept, so an unreachable lookup is retried. */
const known = new Map<string, boolean>();

/** Long enough for a warm local server or a fresh catalog cache, short enough not to be the wait before a spoken reply. */
const LOOKUP_MS = 2_500;

const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref?.())]);

/** Ollama says what each pulled model can do, and "vision" is one of the answers. */
async function ollamaSees(p: ProviderInfo, model: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${providerAddress(p)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
    if (!res.ok) return undefined;
    const caps = ((await res.json()) as { capabilities?: unknown }).capabilities;
    return Array.isArray(caps) ? caps.includes("vision") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does this model take images? The provider's own answer where it gives one
 * (Ollama), then models.dev's input modalities, then the same name heuristic the
 * model picker badges with.
 */
export async function takesImages(p: ProviderInfo, model: string): Promise<boolean> {
  const key = `${p.baseURL} ${model}`;
  const hit = known.get(key);
  if (hit !== undefined) return hit;
  const catalogId = (p as { catalogId?: string }).catalogId;
  const read = p.id === "ollama"
    ? await ollamaSees(p, model)
    : (await within(catalogModels(catalogId), LOOKUP_MS))?.[model]?.modalities?.input?.includes?.("image") as boolean | undefined;
  if (read !== undefined) known.set(key, read);
  return read ?? modelVision(p.id, model);
}

const DESCRIBE = `You are the eyes of an assistant that operates the user's computer for them and cannot see. Describe the picture so it can act on it: which app and window it shows, all readable text quoted exactly, the buttons, fields, links and menus, and where each one is as approximate x,y pixel positions in this picture. Plain sentences, no preamble.`;

async function describe(eyes: ResolvedLive, m: Extract<Message, { role: "tool" }>, signal: AbortSignal): Promise<string> {
  const turn = await collectTurn(
    streamProvider(eyes.provider, eyes.apiKey ?? undefined, {
      model: eyes.model,
      tools: [],
      maxTokens: 800,
      messages: [
        { role: "system", text: DESCRIBE },
        { role: "user", text: `The ${m.name} tool returned this with it: ${m.result.slice(0, 1000)}`, images: m.images },
      ],
    }, signal),
    () => {},
  );
  return turn.text.trim();
}

const blindNote = (model: string) =>
  `[A picture came with this result, but ${model} cannot take images, so it was not sent. Do not describe it or say you can see it. Work from text: a tool that reads the screen as text, or what the user tells you.]`;

/**
 * The transcript as this turn's model can take it. Pictures in tool results stay
 * when the model sees; otherwise each becomes the vision model's description, or
 * the note that it was not sent. `described` remembers descriptions by call id,
 * because the transcript is sent again every turn and a picture is only worth
 * describing once.
 */
export async function prepareToolImages(
  messages: Message[],
  live: ResolvedLive,
  signal: AbortSignal,
  described: Map<string, string>,
  eyes: () => ResolvedLive | null = resolveVision,
): Promise<Message[]> {
  if (!messages.some((m) => m.role === "tool" && m.images?.length)) return messages;
  if (await takesImages(live.provider, live.model)) return messages;
  const v = eyes();
  const helper = v && !(v.provider.id === live.provider.id && v.model === live.model) ? v : null;
  return Promise.all(messages.map(async (m): Promise<Message> => {
    if (m.role !== "tool" || !m.images?.length) return m;
    let note = blindNote(live.model);
    if (helper) {
      let text = described.get(m.callId);
      if (text === undefined) {
        try { text = await describe(helper, m, signal); } catch { text = ""; }
        if (text) described.set(m.callId, text);
      }
      if (text) note = `[${live.model} cannot take images, so ${helper.model} looked at the picture that came with this result and reports: ${text}]`;
    }
    return { ...m, images: undefined, result: `${m.result}\n\n${note}` };
  }));
}
