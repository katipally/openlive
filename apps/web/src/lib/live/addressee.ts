// The page's side of the side talk check (services/agent/src/voice/addressee.ts):
// the agent holds the model; the page sends it each finished sentence.
import type { Feats } from "@openlive/shared/speech/addressee";

// The check takes ~5-10 ms on the agent (docs/ARCHITECTURE.md). One slower than
// this is no use to a turn that waits on it: the sentence goes through.
const JUDGE_TIMEOUT_MS = 800;

/** True only when the agent judged `text` side talk; unreachable, slow, not
 *  downloaded or failing, it is said to the app: the check never blocks the
 *  user on its own failure. `reply`: the agent's last reply as voiced;
 *  `speaker`: the voiceprint's label, when it is on; `keep`: log the judgment
 *  under this id (the judgment log is on), in this mode. */
export async function sideTalk(text: string, reply: string, speaker: string | undefined, feats: Feats, keep?: { id: string; mode: "shadow" | "ignore" }): Promise<boolean> {
  try {
    const res = await fetch("/api/voice/addressee", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, reply, speaker, feats, ...keep }), signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    return res.ok && (await res.json() as { side?: boolean }).side === true;
  } catch { return false; }
}

/** The user's correction of a logged judgment: "to" (Send it), "side" (Not for
 *  you). Best effort: a lost label only costs one training example. */
export function labelJudgment(id: string, label: "to" | "side") {
  void fetch("/api/voice/addressee/label", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, label }) }).catch(() => {});
}

export interface AddresseeStatus { installed: boolean; head: "personal" | "shipped"; log: { count: number; labelled: number; cap: number } }
export const addresseeStatus = async (): Promise<AddresseeStatus | null> => {
  const res = await fetch("/api/voice/addressee").catch(() => null);
  return res?.ok ? res.json() : null;
};
export const deleteJudgmentLog = async () => { await fetch("/api/voice/addressee/log", { method: "DELETE" }); };
