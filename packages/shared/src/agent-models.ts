// A coding agent names its own models, and renames them between adapter versions.
// A saved id that the agent's current list no longer holds is mapped to the entry
// that carries on its family, instead of being sent to an agent that rejects it.

type Named = { id: string; name?: string };

const withoutSuffix = (id: string) => id.replace(/\[[^\]]*\]$/, "");

/** The entry of `models` that `saved` means today, or null when the agent offers none.
 *  Order: the id as is, the id without a bracketed suffix (`opus[1m]` is `opus`), then
 *  the entries whose id or name holds a word of the saved id (`claude-fable-5-1` is
 *  `fable`). The first word is the vendor (`claude`, `gpt`) unless it is the only one,
 *  and a word every entry holds says nothing, so the rarest one decides and the
 *  shortest id among its entries wins, which is the alias that follows the newest. O(n * w). */
export function resolveAgentModel(saved: string, models: readonly Named[]): string | null {
  const exact = (id: string) => models.find((m) => m.id === id)?.id;
  const base = withoutSuffix(saved);
  const found = exact(saved) ?? exact(base);
  if (found) return found;
  const all = [...new Set(base.toLowerCase().match(/[a-z]{3,}/g) ?? [])];
  const words = all.length > 1 ? all.slice(1) : all;
  const hay = models.map((m) => `${m.id} ${m.name ?? ""}`.toLowerCase());
  let best: string[] = [];
  for (const word of words) {
    const hits = models.filter((_, i) => hay[i]!.includes(word)).map((m) => m.id);
    if (hits.length && hits.length < models.length && (!best.length || hits.length < best.length)) best = hits;
  }
  return best.reduce<string | null>((a, id) => (a === null || id.length < a.length ? id : a), null);
}

/** The model a new call starts on: this chat's own pick, else the saved default (both
 *  matched to what the agent offers today), else the agent's own current one. O(n * w). */
export function initialAgentModel(models: readonly Named[], current: string | null, chatPick?: string, savedDefault?: string): string | null {
  const pick = (saved?: string) => (saved ? resolveAgentModel(saved, models) : null);
  return pick(chatPick) ?? pick(savedDefault) ?? current;
}
