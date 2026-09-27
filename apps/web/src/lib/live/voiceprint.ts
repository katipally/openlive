// The page's side of the voiceprint (services/agent/src/voice/voiceprint.ts):
// the agent holds the model and the enrolled print; the page sends it audio.
// Every call gives null when the agent is unreachable or fails, and the gate
// then lets the speech through: it may never block the user on its own failure.

export interface VoiceprintStatus { engine: string; installed: boolean; enrolled: boolean; prints: { mic: string; seconds: number; at: number }[] }
export interface Verdict { you: boolean; score: number; embedding: number[] }

// A verdict later than this after the request left is no use to a barge-in, which
// waits on it: the segment goes through as the user's. Extraction takes ~10-70 ms
// (docs/ARCHITECTURE.md).
const VERIFY_TIMEOUT_MS = 1500;

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<T | null> {
  // The browser sends a fetch only once the page's current task ends, which on a
  // busy page (a long render or script) can be seconds later.
  // The clock starts then, so it times the agent, not the page: a verdict on its
  // way is waited for, and only an agent that is down or stuck lets speech through.
  const abort = new AbortController();
  let timer = setTimeout(() => { timer = setTimeout(() => abort.abort(), timeoutMs); }, 0);
  try {
    const res = await fetch(`/api/voice/voiceprint${path}`, { ...init, signal: abort.signal });
    return res.ok ? await res.json() as T : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
const pcm = (samples: Float32Array): RequestInit => ({ method: "POST", headers: { "content-type": "application/octet-stream" }, body: samples as Float32Array<ArrayBuffer> });
const q = (o: Record<string, string | boolean>) => `?${new URLSearchParams(Object.entries(o).map(([k, v]) => [k, v === true ? "1" : String(v)])).toString()}`;

export const voiceprintStatus = () => call<VoiceprintStatus>("");
/** `voicedMs`: how much of `samples` the VAD heard as speech, which sets the threshold. */
export const verifyVoice = (samples: Float32Array, mic: string, voicedMs: number) =>
  call<Verdict>(`/verify${q({ mic, voiced: String(Math.round(voicedMs)) })}`, pcm(samples), VERIFY_TIMEOUT_MS);
/** `fresh` starts this mic's print over. */
export const enrollVoice = (samples: Float32Array, mic: string, fresh: boolean) => call<VoiceprintStatus>(`/enroll${q({ mic, fresh })}`, pcm(samples));
export const forgetVoiceprint = () => call<VoiceprintStatus>("", { method: "DELETE" });
