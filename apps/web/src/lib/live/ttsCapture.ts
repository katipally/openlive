// Debug recorder of what the voice engine really plays: each piece's PCM, the
// text and voice it was asked with, the route that produced it and where it
// landed on the audio clock. Off unless localStorage["openlive-debug"] holds
// "tts" and the page is on this machine. Everything goes to the local agent
// (data/debug/tts-capture/<run>/<reply>/), fire and forget, so playback never
// waits on it; read it back with `pnpm voice:capture <run dir>`.
import type { PlayInfo } from "./audioPlayback";
import type { TtsSource } from "./models";

// PCM uploads run MAX_IN_FLIGHT at a time and queue behind them; a piece that
// would take the queue past QUEUE_BYTES (about 11 minutes of 24 kHz audio) is not
// recorded, so a slow or absent agent costs bounded memory and never a delay.
const MAX_IN_FLIGHT = 4;
const QUEUE_BYTES = 64 * 1024 * 1024;
const MANIFEST_DELAY_MS = 300;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const enabled = () => {
  try { return /\btts\b/.test(localStorage.getItem("openlive-debug") ?? "") && LOCAL_HOSTS.includes(location.hostname); } catch { return false; }
};

export interface PartMeta {
  reply: number; chunk: number; piece: number; epoch: number; outOfBand: boolean;
  said: string; spoken: string; askedAt: number; sampleRate: number;
  voice: { engine: string; family: string; voice: string; speed: number; lang: string };
  source: TtsSource | undefined;
}
interface Reply { id: string; manifest: Record<string, unknown> & { pieces: unknown[]; events: unknown[] }; key: string; part: number; timer?: ReturnType<typeof setTimeout> }

const run = new Date().toISOString().replace(/[:.]/g, "-");
let replies = 0, inFlight = 0, noted = false, queuedBytes = 0;
let cur: Reply | null = null;
const queue: { reply: string; file: string; pcm: Float32Array }[] = [];

/** A new id for each spoken reply, shared by every engine on the page. */
export const nextCaptureReply = () => ++replies;

function put(reply: string, file: string, body: BodyInit): Promise<void> {
  return fetch(`/api/voice/debug/tts-capture/${run}/${reply}/${file}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
    .catch((e) => { if (!noted) { noted = true; console.warn("[tts-capture] the agent did not take the capture, so it is skipped (is the agent running on this machine?):", e); } });
}
function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const { reply, file, pcm } = queue.shift()!;
    queuedBytes -= pcm.byteLength;
    inFlight++;
    void put(reply, file, pcm as Float32Array<ArrayBuffer>).finally(() => { inFlight--; pump(); });
  }
}
const sendManifest = (r: Reply) => { clearTimeout(r.timer); r.timer = undefined; void put(r.id, "manifest.json", JSON.stringify(r.manifest, null, 1)); };
const touch = (r: Reply) => { r.timer ??= setTimeout(() => sendManifest(r), MANIFEST_DELAY_MS); };

/** One chunk of audio just handed to the player (`at` is what play() returned). */
export function capturePart(m: PartMeta, audio: Float32Array, at: PlayInfo | undefined) {
  if (!at || !enabled()) return;
  const id = `reply-${String(m.reply).padStart(3, "0")}`;
  if (cur?.id !== id) {
    if (cur?.timer) sendManifest(cur);
    cur = { id, key: "", part: 0, manifest: { run, reply: id, startedAt: Date.now(), pieces: [], events: [] } };
  }
  const r = cur, n = r.manifest.pieces.length, first = n === 0;
  const key = `${m.chunk}.${m.piece}`;
  r.part = key === r.key ? r.part + 1 : 0;
  r.key = key;
  const gap = first ? null : at.startAt - at.prevEnd;
  const pcm = queuedBytes + audio.byteLength <= QUEUE_BYTES ? `p${String(n).padStart(4, "0")}.f32` : null;
  Object.assign(r.manifest, { ctxSampleRate: at.rate, baseLatency: at.baseLatency, outputLatency: at.outputLatency ?? null });
  r.manifest.pieces.push({
    n, chunk: m.chunk, piece: m.piece, part: r.part, epoch: m.epoch, outOfBand: m.outOfBand,
    said: m.said, spoken: m.spoken, ...m.voice,
    route: m.source?.route ?? null, usedEngine: m.source?.engine ?? null, fallback: m.source?.fallback ?? null,
    sampleRate: m.sampleRate, samples: audio.length, durationS: audio.length / m.sampleRate,
    askedAt: m.askedAt, arrivedAt: Date.now(),
    startAt: at.startAt, now: at.now, prevEnd: first ? null : at.prevEnd, gap, underrun: gap !== null && gap > 1e-6, held: at.held,
    pcm,
  });
  if (pcm) { queue.push({ reply: id, file: pcm, pcm: audio }); queuedBytes += audio.byteLength; pump(); }
  touch(r);
}

/** hold, release or flush on the player, at context time `ctxTime`. */
export function captureEvent(kind: "hold" | "release" | "flush", ctxTime: number | undefined) {
  if (!cur || !enabled()) return;
  cur.manifest.events.push({ kind, at: Date.now(), ctxTime: ctxTime ?? null });
  touch(cur);
}
