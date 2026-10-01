import { getSetting, setSetting } from "@openlive/db";
import { bestScore, fold, informative, type Print } from "@openlive/shared/speech/voiceprint";
import { engineInstalled, NATIVE_FAMILIES } from "./native-models.js";
import { embed } from "./native.js";
import { SAMPLE_RATE } from "./pcm.js";

// The enrolled user's voiceprint: a mean speaker embedding per microphone,
// kept encrypted in the home's secrets/ (never exposed by /api/settings, never
// sent anywhere) and gone with one DELETE. The live gate (apps/web
// voiceEngine.ts) asks verify() whether a segment is the user.
// Enrollment is explicit: the user reads for ~15 s in Settings. Passive
// enrollment from the first turns was ruled out: in a shared room the first
// voice heard need not be the user's, and a print seeded by someone else
// would then let them in and shut the user out. After that, a turn scored far
// above the threshold is folded into the print of the mic it came from, so the
// print follows the user's voice, and a new mic gets a print of its own
// without pulling the first one toward it.

export const SPEAKER_MODEL = NATIVE_FAMILIES.find((f) => f.kind === "speaker")!.variants[0]!;
// The user's own voice scores lower the less of it there is, so each length of
// speech has its threshold: [seconds voiced, threshold], each the highest that
// blocked at most 1% of the user's trials of that length in tools/voiceprint
// (2026-09-26; docs/ARCHITECTURE.md has the error rates). A segment takes the
// row of the longest length it reaches. Under a second almost anyone passes:
// that little speech cannot tell voices apart.
export const THRESHOLDS: [number, number][] = [[0, -0.085], [1, 0.087], [2, 0.286], [4, 0.4]];
// A segment this sure is the user's, with this much speech in it for a steady
// sample, is folded into their print.
const ADAPT = 0.6;
const ADAPT_MIN_S = 2;
// The gate turns on once this much of the user's speech is in a print.
export const ENROLLED_S = 10;
// A mic not heard for longest goes first past this many.
const MAX_PRINTS = 6;
const KEY = "voiceprint";

/** `engine`: the model the prints were made with; another model's embeddings do not compare. */
interface Stored { engine: string; prints: Print[] }

function stored(): Stored {
  try {
    const s = JSON.parse(getSetting(KEY) || "null") as Stored | null;
    if (s?.engine === SPEAKER_MODEL.id && Array.isArray(s.prints)) return s;
  } catch { /* unreadable: start over */ }
  return { engine: SPEAKER_MODEL.id, prints: [] };
}
const save = (s: Stored) => setSetting(KEY, JSON.stringify(s));

/** For Settings and the gate: whether the model is here and the user enrolled. */
export function voiceprintStatus() {
  const { prints } = stored();
  return {
    engine: SPEAKER_MODEL.id,
    installed: engineInstalled(SPEAKER_MODEL),
    enrolled: prints.some((p) => p.seconds >= ENROLLED_S),
    prints: prints.map(({ mic, seconds, at }) => ({ mic, seconds: Math.round(seconds), at })),
  };
}

/** Folds `e` from `seconds` of speech into `mic`'s print, making one if the
 *  mic is new. O(prints x d). */
function learn(s: Stored, mic: string, e: Float32Array, seconds: number) {
  let p = s.prints.find((x) => x.mic === mic);
  if (!p) {
    s.prints.sort((a, b) => b.at - a.at).splice(MAX_PRINTS - 1);
    s.prints.push(p = { mic, mean: [], n: 0, seconds: 0, at: 0 });
  }
  Object.assign(p, { mean: fold(p, e), n: p.n + 1, seconds: p.seconds + seconds, at: Date.now() });
}

/** One stretch of the user reading in Settings. `fresh` starts `mic`'s print
 *  over. null when the embedding says nothing about the voice (informative()):
 *  folded in, a NaN one would turn the whole print to NaN for good. */
export async function enroll(samples: Float32Array, mic: string, fresh: boolean) {
  const seconds = samples.length / SAMPLE_RATE;
  const e = await embed(SPEAKER_MODEL, samples);
  if (!informative(e)) return null;
  const s = stored();
  if (fresh) s.prints = s.prints.filter((p) => p.mic !== mic);
  learn(s, mic, e, seconds);
  await save(s);
  return voiceprintStatus();
}

/** Is `samples`, `voiced` seconds of it speech, the enrolled user? `score`:
 *  the best cosine over their prints; `embedding` lets the caller tell the
 *  other voices apart. null, no verdict, when the embedding says nothing about
 *  the voice: its score of 0 would pass the under-a-second threshold.
 *  O(prints x d) past the embedding. */
export async function verify(samples: Float32Array, mic: string, voiced: number) {
  const e = await embed(SPEAKER_MODEL, samples);
  if (!informative(e)) return null;
  const s = stored();
  const score = bestScore(s.prints, e);
  if (score >= ADAPT && voiced >= ADAPT_MIN_S) {
    learn(s, mic, e, voiced);
    await save(s);
  }
  const threshold = THRESHOLDS.findLast(([at]) => voiced >= at)![1];
  return { you: score >= threshold, score, embedding: Array.from(e) };
}

export const forgetVoiceprint = () => setSetting(KEY, "");
