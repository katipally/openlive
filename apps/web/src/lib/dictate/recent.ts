import { DICTATE_CONTEXT_RECENT_CHARS, DICTATE_CONTEXT_RECENT_MAX } from "@openlive/shared";

// What AI polish may be told of the field it types into besides the text
// before the cursor (which the native side reads): the last few dictations
// typed in the same window. In memory only, never written anywhere, and never
// a dictation that was copied instead of typed.

/** Where the words land, as /api/dictate/rewrite takes it. */
export interface RewriteContext { before?: string; recent?: string[] }

/** Half an hour on, what was said is no longer what the field is about. */
const STALE_MS = 30 * 60_000;
const MAX_WINDOWS = 20;

const byWindow = new Map<number, { text: string; at: number }[]>();

/** Remembers one typed dictation for its window. A Map keeps insertion order, so the oldest window is the first key. */
export function rememberDictation(windowId: number | undefined, text: string, now = Date.now()): void {
  const t = text.trim();
  if (windowId === undefined || !t) return;
  const list = byWindow.get(windowId) ?? [];
  byWindow.delete(windowId);
  list.push({ text: t.slice(-DICTATE_CONTEXT_RECENT_CHARS), at: now });
  byWindow.set(windowId, list.slice(-DICTATE_CONTEXT_RECENT_MAX));
  if (byWindow.size > MAX_WINDOWS) byWindow.delete(byWindow.keys().next().value!);
}

/** The recent dictations of `windowId` alone, oldest first, within the total the agent takes. Empty for an unknown window. */
export function recentFor(windowId: number | undefined, now = Date.now()): string[] {
  const out: string[] = [];
  let budget = DICTATE_CONTEXT_RECENT_CHARS;
  for (const { text, at } of [...(byWindow.get(windowId ?? -1) ?? [])].reverse()) {
    if (now - at > STALE_MS || budget <= 0) break;
    out.unshift(text.slice(-budget));
    budget -= text.length;
  }
  return out;
}

export const forgetDictations = () => byWindow.clear();
