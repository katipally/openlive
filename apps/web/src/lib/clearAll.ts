/** The Clear all row for `count` kept, one of them `held` ("open", "running")
 *  and so left by it. Disabled, with why, when that one is all there is; none
 *  with nothing kept. Pure. */
export function clearAllRow(count: number | undefined, noun: string, held?: string): { detail: string; confirm: string; disabled: boolean } | null {
  if (!count) return null;
  const one = noun.replace(/s$/, "");
  const n = count - (held ? 1 : 0);
  if (n <= 0) return { detail: `Only the ${held} ${one} is left, and it stays`, confirm: "", disabled: true };
  return { detail: held ? `Deletes every kept ${one} but the ${held} one` : `Deletes every kept ${one}`, confirm: n === 1 ? "Delete it" : `Delete all ${n}`, disabled: false };
}
