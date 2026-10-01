// Reads what the live app played, as written by its debug TTS capture
// (apps/web/src/lib/live/ttsCapture.ts, <home>/cache/debug/tts-capture/<run>/<reply>/),
// and prints per piece the pace, pitch, silences, gap before it and route, then
// how adjacent pieces differ and where a join or the middle of a piece clicks.
// Writes reconstruction.wav beside each manifest: the reply laid out on the
// real audio clock, gaps included.
//   pnpm voice:capture <a reply dir, a run dir, or the whole tts-capture dir>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { edge, HOP_S, leadTail, median, semitones, speech, track } from "./analyze";

const PAUSE_S = 0.15;    // a silent run this long inside speech is a pause, not articulation
const EDGE_S = 0.002, SPIKE_S = 0.002;
const EDGE_MAX = 0.01;   // -40 dBFS: audio cut off or begun above this against silence is a click
const STEP_MIN = 0.02, STEP_X = 4;      // a sample step between adjoining pieces: absolute, and times the local slope
const DC_MAX = 0.005, DC_STEP = 0.01;   // mean level of a piece, and its change across a join
const SPIKE_MIN = 0.05, SPIKE_X = 4;    // a sample step inside a piece: absolute, and times the steepest step around it
const ADJOINING_S = 0.001;              // a gap under this is no gap
const MIN_SPEECH_S = 1, MIN_CHARS = 8, MIN_VOICED = 10; // below these a pace or pitch is noise
const MAX_SPAN_S = 1800;

export interface Part {
  n: number; chunk: number; piece: number; part: number; said: string; spoken: string;
  engine: string; family: string; voice: string; speed: number; lang: string;
  route: string | null; usedEngine: string | null; fallback: boolean | null;
  sampleRate: number; samples: number; durationS: number; askedAt: number; arrivedAt: number;
  startAt: number; now: number; prevEnd: number | null; gap: number | null; underrun: boolean; held: boolean; pcm: string | null;
}
export interface Manifest { run: string; reply: string; ctxSampleRate?: number; baseLatency?: number; outputLatency?: number | null; events: { kind: string; ctxTime: number | null }[]; pieces: Part[] }

const mean = (x: Float32Array) => { let s = 0; for (const v of x) s += v; return s / Math.max(1, x.length); };
const slope = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = Math.max(1, a); i < b; i++) s += Math.abs(x[i]! - x[i - 1]!); return s / Math.max(1, b - a); };
const win = (s: number, rate: number) => Math.max(2, Math.round(s * rate));

/** Characters per second of speech, pauses of PAUSE_S or more taken out, and the median F0. */
export function articulation(x: Float32Array, sr: number, chars: number) {
  const t = track(x, sr), [s, e] = speech(t, 0, t.active.length);
  let paused = 0, run = 0;
  for (let f = s; f < e; f++) {
    if (t.active[f]) { if (run * HOP_S >= PAUSE_S) paused += run; run = 0; } else run++;
  }
  const speechS = (e - s - paused) * HOP_S;
  return { cps: e > s ? chars / speechS : NaN, speechS, f0: median(t.f0), voiced: t.f0.filter(Number.isFinite).length, t };
}

/** What the signal does where it meets silence, or the next piece when `adjoining`,
 *  and each piece's mean level (a window of a few pitch periods would read a
 *  voice's own swing as an offset). Either side is null at a reply's start and end. O(n). */
export function joinCheck(a: Float32Array | null, ra: number, b: Float32Array | null, rb: number, adjoining: boolean) {
  const end = a?.length ? a[a.length - 1]! : 0, start = b?.length ? b[0]! : 0;
  const dcEnd = a?.length ? mean(a) : 0, dcStart = b?.length ? mean(b) : 0;
  const scale = Math.max(1e-4, ((a?.length ? slope(a, a.length - win(EDGE_S, ra), a.length) : 0) + (b?.length ? slope(b, 0, win(EDGE_S, rb)) : 0)) / 2);
  const step = adjoining ? Math.abs(start - end) : 0;
  const flags: string[] = [];
  if (adjoining) { if (step > STEP_MIN && step > STEP_X * scale) flags.push("jump"); }
  else {
    if (Math.abs(end) > EDGE_MAX) flags.push("abrupt-end");
    if (Math.abs(start) > EDGE_MAX) flags.push("abrupt-start");
  }
  if (Math.abs(dcEnd) > DC_MAX || Math.abs(dcStart) > DC_MAX || (adjoining && Math.abs(dcEnd - dcStart) > DC_STEP)) flags.push("dc");
  return { end, start, step, dcEnd, dcStart, flags };
}

/** Seconds into `x` of each sample step that towers over every step within
 *  SPIKE_S of it (a click or pop; a consonant's burst has neighbours as steep),
 *  at most one per millisecond. O(n + candidates x window). */
export function spikes(x: Float32Array, sr: number): number[] {
  const w = win(SPIKE_S, sr), at: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < x.length; i++) {
    const d = Math.abs(x[i]! - x[i - 1]!);
    if (d < SPIKE_MIN || i - last < sr / 1000) continue;
    let around = 0;
    for (let k = Math.max(1, i - w); k <= Math.min(x.length - 1, i + w); k++) if (Math.abs(k - i) > 1) around = Math.max(around, Math.abs(x[k]! - x[k - 1]!));
    if (d > SPIKE_X * around) { at.push(i / sr); last = i; }
  }
  return at;
}

const resample = (x: Float32Array, from: number, to: number) => {
  if (from === to) return x;
  const out = new Float32Array(Math.round((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to, j = Math.floor(p), f = p - j;
    out[i] = x[j]! * (1 - f) + (x[j + 1] ?? x[j]!) * f;
  }
  return out;
};

/** The audio laid out at `rate` on the clock it was scheduled on, or null when it spans more than MAX_SPAN_S. */
export function reconstruct(parts: { x: Float32Array; rate: number; startAt: number }[], rate: number): Float32Array | null {
  const t0 = Math.min(...parts.map((p) => p.startAt)), end = Math.max(...parts.map((p) => p.startAt + p.x.length / p.rate));
  if (!parts.length || end - t0 > MAX_SPAN_S) return null;
  const out = new Float32Array(Math.ceil((end - t0) * rate) + 1);
  for (const p of parts) { const x = resample(p.x, p.rate, rate), at = Math.round((p.startAt - t0) * rate); for (let i = 0; i < x.length; i++) out[at + i] = (out[at + i] ?? 0) + x[i]!; }
  return out;
}

function wav16(x: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + 2 * x.length);
  b.write("RIFF", 0); b.writeUInt32LE(36 + 2 * x.length, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(2 * rate, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(2 * x.length, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), 44 + 2 * i);
  return b;
}

const f32 = (file: string) => { const b = readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const cat = (xs: Float32Array[]) => { const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); xs.reduce((o, x) => (out.set(x, o), o + x.length), 0); return out; };
const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const col = (v: string | number, w: number) => String(v).padStart(w);
const ms = (s: number | null) => (s == null ? null : s * 1000);

interface Piece { key: string; parts: Part[]; x: Float32Array | null; chars: number }

function report(dir: string) {
  const m: Manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const loaded = m.pieces.map((p) => ({ p, x: p.pcm && existsSync(join(dir, p.pcm)) ? f32(join(dir, p.pcm)) : null }));
  console.log(`\n== ${m.run} / ${m.reply}: ${m.pieces.length} audio chunks, context ${m.ctxSampleRate ?? "?"} Hz, base latency ${fmt(ms(m.baseLatency ?? null), 0)} ms, output latency ${fmt(ms(m.outputLatency ?? null), 0)} ms`);
  if (m.events.length) console.log(`   events: ${m.events.map((e) => `${e.kind}@${fmt(e.ctxTime, 2)}s`).join(" ")}`);
  const vary = (k: (p: Part) => unknown) => new Set(m.pieces.map((p) => String(k(p)))).size > 1;
  for (const [what, k] of [["route", (p: Part) => `${p.route}${p.fallback ? "(fallback)" : ""}`], ["engine ran", (p: Part) => p.usedEngine], ["voice", (p: Part) => `${p.engine}/${p.voice}/${p.speed}`], ["sample rate", (p: Part) => p.sampleRate], ["lang", (p: Part) => p.lang]] as const) {
    if (vary(k)) console.log(`   MIXED ${what}: ${[...new Set(m.pieces.map((p) => String(k(p))))].join(", ")}`);
  }

  const groups = new Map<string, Piece>();
  for (const { p } of loaded) {
    const key = `${p.chunk}.${p.piece}`, g = groups.get(key) ?? { key, parts: [], x: null, chars: p.said.length };
    g.parts.push(p); groups.set(key, g);
  }
  const pieces = [...groups.values()];
  for (const g of pieces) {
    const xs = loaded.filter(({ p }) => g.parts.includes(p)).map(({ x }) => x);
    g.x = xs.every((x) => x) ? cat(xs as Float32Array[]) : null;
  }

  console.log(`\n${col("piece", 6)} ${col("parts", 5)} ${col("route", 11)} ${col("sr", 6)} ${col("chars", 5)} ${col("cps", 5)} ${col("f0 Hz", 6)} ${col("lead", 5)} ${col("tail", 5)} ${col("gap ms", 7)} ${col("inner", 6)} ${col("synth", 6)} ${col("ahead", 6)} U  ${col("clicks", 6)}  text (said)`);
  const stats = pieces.map((g) => {
    const first = g.parts[0]!, sr = first.sampleRate;
    const a = g.x ? articulation(g.x, sr, g.chars) : null, lt = g.x ? leadTail(g.x, sr) : null;
    const inner = g.parts.slice(1).reduce((s, p) => s + (p.gap ?? 0), 0);
    const clicks = g.x ? spikes(g.x, sr) : [];
    console.log(`${col(g.key, 6)} ${col(g.parts.length, 5)} ${col((first.route ?? "?") + (first.fallback ? "*" : ""), 11)} ${col(sr, 6)} ${col(g.chars, 5)} ${col(fmt(a?.cps), 5)} ${col(fmt(a?.f0, 0), 6)} ${col(fmt(ms(lt?.lead ?? null), 0), 5)} ${col(fmt(ms(lt?.tail ?? null), 0), 5)} ${col(fmt(ms(first.gap), 0), 7)} ${col(fmt(ms(inner), 0), 6)} ${col(fmt(first.arrivedAt - first.askedAt, 0), 6)} ${col(fmt(ms(first.startAt - first.now), 0), 6)} ${g.parts.some((p) => p.underrun) ? "U" : "."}  ${col(clicks.length, 6)}  ${first.said.slice(0, 48)}${first.said.length > 48 ? "..." : ""}`);
    return { g, a, clicks };
  });

  console.log(`\n${col("pair", 11)} ${col("dF0 st", 7)} ${col("join st", 8)} ${col("pace x", 7)}`);
  let maxSt = 0, maxJoinSt = 0, maxPace = 1;
  for (let i = 1; i < stats.length; i++) {
    const [p, q] = [stats[i - 1]!, stats[i]!];
    const ok = (s: typeof p) => s.a && s.a.voiced >= MIN_VOICED;
    const st = ok(p) && ok(q) ? semitones(q.a!.f0, p.a!.f0) : NaN;
    const e0 = p.a && edge(p.a.t, speech(p.a.t, 0, p.a.t.active.length)[1], true), e1 = q.a && edge(q.a.t, speech(q.a.t, 0, q.a.t.active.length)[0], false);
    const js = e0 && e1 ? semitones(e1.f0, e0.f0) : NaN;
    const solid = (s: typeof p) => s.a && s.a.speechS >= MIN_SPEECH_S && s.g.chars >= MIN_CHARS;
    const pace = solid(p) && solid(q) ? q.a!.cps / p.a!.cps : NaN;
    if (Number.isFinite(st)) maxSt = Math.max(maxSt, Math.abs(st));
    if (Number.isFinite(js)) maxJoinSt = Math.max(maxJoinSt, Math.abs(js));
    if (Number.isFinite(pace)) maxPace = Math.max(maxPace, pace, 1 / pace);
    console.log(`${col(`${p.g.key}>${q.g.key}`, 11)} ${col(fmt(st), 7)} ${col(fmt(js), 8)} ${col(fmt(pace, 2), 7)}`);
  }

  console.log(`\n${col("join", 9)} ${col("gap ms", 7)} ${col("end", 8)} ${col("start", 8)} ${col("step", 7)} ${col("mean prev", 9)} ${col("mean next", 9)}  flags`);
  let flagged = 0;
  const present = loaded.filter(({ x }) => x), at = (i: number) => present[i];
  for (let i = 0; i <= present.length; i++) {
    const [a, b] = [at(i - 1), at(i)], adj = !!a && !!b && (b.p.gap ?? Infinity) <= ADJOINING_S && a.p.sampleRate === b.p.sampleRate;
    const c = joinCheck(a?.x ?? null, a?.p.sampleRate ?? 0, b?.x ?? null, b?.p.sampleRate ?? 0, adj);
    if (c.flags.length) flagged++;
    console.log(`${col(`${a ? a.p.n : "start"}>${b ? b.p.n : "end"}`, 9)} ${col(b ? fmt(ms(b.p.gap), 0) : "-", 7)} ${col(fmt(c.end, 4), 8)} ${col(fmt(c.start, 4), 8)} ${col(fmt(c.step, 4), 7)} ${col(fmt(c.dcEnd, 4), 9)} ${col(fmt(c.dcStart, 4), 9)}  ${c.flags.join(" ")}`);
  }
  const loud = stats.filter((s) => s.clicks.length);
  for (const s of loud) console.log(`   clicks inside piece ${s.g.key} at ${s.clicks.slice(0, 5).map((t) => fmt(t, 3)).join(", ")} s`);

  const rec = present.length ? reconstruct(present.map(({ p, x }) => ({ x: x!, rate: p.sampleRate, startAt: p.startAt })), present[0]!.p.sampleRate) : null;
  if (rec) writeFileSync(join(dir, "reconstruction.wav"), wav16(rec, present[0]!.p.sampleRate));
  const under = m.pieces.filter((p) => p.underrun).length, medF0 = stats.map((s) => s.a?.f0 ?? NaN).filter(Number.isFinite);
  console.log(`\nsummary ${m.reply}: ${pieces.length} pieces, ${under} underruns, ${flagged} joins flagged, ${loud.length} pieces with clicks inside`);
  console.log(`  median F0 across pieces ${fmt(Math.min(...medF0), 0)} to ${fmt(Math.max(...medF0), 0)} Hz, largest adjacent pitch jump ${fmt(maxSt)} st (at a join ${fmt(maxJoinSt)} st), largest adjacent pace ratio ${fmt(maxPace, 2)}x`);
  console.log(rec ? `  wrote ${join(dir, "reconstruction.wav")}` : "  no reconstruction (no PCM kept, or a span over 30 minutes)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: pnpm voice:capture <a reply dir, a run dir, or the whole tts-capture dir>"); process.exit(1); }
  const root = resolve(process.env.INIT_CWD ?? ".", arg);
  const manifests = (d: string): string[] => existsSync(join(d, "manifest.json")) ? [d] : existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((x, y) => x.name.localeCompare(y.name)).flatMap((e) => manifests(join(d, e.name))) : [];
  const dirs = manifests(root);
  if (!dirs.length) { console.error(`no manifest.json in ${root} or its folders`); process.exit(1); }
  for (const d of dirs) report(d);
}
