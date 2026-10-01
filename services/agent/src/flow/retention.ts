import type { Msg } from "./types.js";

// Screenshots are the most expensive thing in a Flow transcript and the fastest
// to go stale: the screen they show stopped existing the moment the next action
// ran. Only the picture goes. The call and its result text stay, so the model
// still knows which actions it already took, and no call loses its result (a
// strict provider rejects either half of a pair on its own).

/** How many image-bearing tool results stay in context. The newest are the true ones. */
export const KEEP_IMAGES = 3;

const REMOVED = "[screenshot removed]";

const hasImages = (m: Msg): boolean => m.role === "tool" && !!m.images?.length;

/** Null when nothing needed dropping, so the caller can leave the array alone. */
export function trimImages(messages: Msg[], keep: number = KEEP_IMAGES): Msg[] | null {
  const withImages: string[] = [];
  for (const m of messages) if (hasImages(m)) withImages.push((m as { callId: string }).callId);
  if (withImages.length <= keep) return null;

  const drop = new Set(withImages.slice(0, withImages.length - keep));
  return messages.map((m) => m.role === "tool" && drop.has(m.callId)
    ? { ...m, images: undefined, result: [m.result, REMOVED].filter(Boolean).join("\n") }
    : m);
}
