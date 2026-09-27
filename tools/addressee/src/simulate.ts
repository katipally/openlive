// A simulated judgment log, for checking the log, the sound features and
// `pnpm addressee:train` end to end before any real one exists. macOS only.
//   AGENT_URL=http://127.0.0.1:<port> pnpm addressee:simulate [--cue none|level] [--voices A,B] [--stt <engine>]
// Each held-out English synthetic sentence (data/test.en.json) is rendered with
// `say -o` to a file (never played) in each voice at its own level, through the
// agent's speech-to-text and the page's Feats (speechStats and the engine's
// running level), then judged by the agent with the log on and labelled with
// its truth. `--cue level` renders side talk 6 dB quieter, as if turned away
// from the mic: a planted cue the features should find. With `--cue none`
// nothing about the sound depends on the label. Either way, a simulated room is
// weak evidence about real ones. Point the agent at a scratch OPENLIVE_DATA_DIR.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { speechStats, type Feats } from "../../../packages/shared/src/speech/addressee";
import { synthetic } from "./data";

const { values: args } = parseArgs({ options: { cue: { type: "string" }, voices: { type: "string" }, stt: { type: "string" } } });
const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8787";
const CUE = args.cue === "level" ? 6 : 0;
const VOICES = (args.voices ?? "Samantha,Daniel").split(",");
const STT = args.stt ?? "nemotron-en-160ms-int8";

// Seeded, so a run can be repeated. mulberry32.
let seed = 42;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** A WAV file's float32 samples: its "data" chunk, found by walking the chunks. */
function wavF32(path: string): Float32Array {
  const b = readFileSync(path);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") return new Float32Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + size));
    at += 8 + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

const post = async (path: string, body: BodyInit, type = "application/json") => {
  const res = await fetch(`${AGENT}/voice/${path}`, { method: "POST", body, headers: { "content-type": type } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const rows = synthetic().filter((r) => r.split === "en");
const dir = mkdtempSync(join(tmpdir(), "ol-addressee-sim-"));
const jobs = rows.flatMap((r, i) => VOICES.map((voice, v) => ({ r, voice, v, id: `sim-${i}-${v}` }))).sort(() => rand() - 0.5);
let userDb: number | null = null, exact = 0;
const t0 = performance.now();
try {
  for (const { r, voice, v, id } of jobs) {
    const file = join(dir, `${id}.wav`);
    const say = spawnSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", "--data-format=LEF32@16000", r.said]);
    if (say.status) throw new Error(`say -v ${voice}: ${say.stderr}`);
    // Each voice at its own level (6 dB apart), give or take 3 dB a sentence,
    // less the cue for side talk; 300 ms of a quiet room (-60 dBFS) either side.
    const gain = 10 ** ((-6 * v + (rand() * 6 - 3) - (r.side ? CUE : 0)) / 20);
    const voiced = wavF32(file), pad = 0.3 * 16000;
    const pcm = new Float32Array(voiced.length + 2 * pad);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i >= pad && i < pad + voiced.length ? voiced[i - pad]! * gain : 0) + (rand() - 0.5) * 2e-3;
    const heard = (await post(`stt?engine=${STT}&lang=en`, Buffer.from(pcm.buffer), "application/octet-stream")) as { text: string };
    const text = heard.text.trim();
    if (text.toLowerCase().replace(/[^a-z ]/g, "") === r.said.toLowerCase().replace(/[^a-z ]/g, "")) exact++;
    if (!text) continue;
    // As voiceEngine.feats: level against the running level, which then moves a fifth of the way.
    const s = speechStats(pcm, text);
    const relDb = s.db != null && userDb != null ? s.db - userDb : null;
    if (s.db != null) userDb = userDb == null ? s.db : userDb + 0.2 * (s.db - userDb);
    const feats: Feats = { relDb, energySd: s.energySd, pitch: s.pitch, pitchSd: s.pitchSd, gapS: 0.3 + rand() * 6, cut: 0, change: null, durS: pcm.length / 16000, rate: s.rate };
    await post("addressee", JSON.stringify({ text, reply: r.reply, feats, id, mode: "shadow" }));
    await post("addressee/label", JSON.stringify({ id, label: r.side ? "side" : "to" }));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${jobs.length} sentences in ${VOICES.join(", ")} (cue ${CUE} dB), transcribed by ${STT} in ${((performance.now() - t0) / 1000).toFixed(0)} s; ${(100 * exact / jobs.length).toFixed(0)}% word for word`);
