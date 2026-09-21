import type { Msg } from "./types.js";

// Screenshots are the most expensive thing in a Flow transcript and the fastest
// to go stale: the screen they show stopped existing the moment the next action
// ran. They are dropped by call id, WITH the assistant call that asked for them,
// because a tool result without its call, or a call without its result, is a
// message a strict provider rejects outright.

/** How many image-bearing tool results stay in context. The newest are the true ones. */
export const KEEP_IMAGES = 3;

const hasImages = (m: Msg): boolean => m.role === "tool" && !!m.images?.length;

/** Null when nothing needed dropping, so the caller can leave the array alone. */
export function trimImages(messages: Msg[], keep: number = KEEP_IMAGES): Msg[] | null {
  const withImages: string[] = [];
  for (const m of messages) if (hasImages(m)) withImages.push((m as { callId: string }).callId);
  if (withImages.length <= keep) return null;

  const drop = new Set(withImages.slice(0, withImages.length - keep));
  const out: Msg[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      if (!drop.has(m.callId)) out.push(m);
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.some((c) => drop.has(c.id))) {
      const toolCalls = m.toolCalls.filter((c) => !drop.has(c.id));
      if (!toolCalls.length && !m.text) continue;
      out.push({ ...m, toolCalls: toolCalls.length ? toolCalls : undefined });
      continue;
    }
    out.push(m);
  }
  return out;
}
