import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR } from "@openlive/db";
import { baseProfile, fingerprint, probeDevice, threadsFor, type DeviceProfile, type Provider } from "./device.js";
import { engineDir, onOrt, type NativeEngine } from "./native-models.js";
import { SAMPLE_RATE } from "./pcm.js";

// Where each native engine runs (ONNX Runtime execution provider) and on how
// many threads, decided on each user's own device. CPU is the default; an
// accelerator is used for a model only once a benchmark on this device shows it
// beats CPU (sherpa-onnx issue #2910: CoreML ran slower than CPU on an M2 Max).
// The device profile, results and the user's overrides live in
// DATA_DIR/voice-accel.json, and never leave the machine.

export interface Accel { provider: Provider; numThreads: number }
/** One provider's run of the fixed benchmark input. loadMs includes a
 *  provider's model compile (CoreML's is seconds) and warmMs the first
 *  inference, so neither counts toward the steady-state firstMs (first audio
 *  chunk, or the clip transcribed) and rtf (wall time over audio length). */
export type BenchResult =
  | { provider: Provider; loadMs: number; warmMs: number; firstMs: number; rtf: number }
  | { provider: Provider; error: string };
/** `results` is empty while a benchmark is under way; `attempts` counts the starts it took. */
export interface AccelEntry { key: string; chosen: Provider; results: BenchResult[]; at: string; attempts?: number }
export type Override = Provider | "auto";
interface Store { device?: DeviceProfile; engines: Record<string, AccelEntry>; overrides: Record<string, Provider> }

// An accelerator must cut the steady-state real-time factor by this much to be
// used: smaller wins are within run-to-run noise and not worth its load cost.
const MIN_GAIN = 0.2;
// Each provider is benchmarked in its own process (native.ts benchInChild), so
// a native crash there only fails that provider. Should a benchmark still take
// the agent down, it never records anything, so its starts are counted on disk:
// after this many unfinished ones the engine stays on CPU.
const MAX_ATTEMPTS = 2;

/** CPU unless an accelerator that ran cleanly beats CPU's rtf by MIN_GAIN. O(results). */
export function chooseProvider(results: BenchResult[]): Provider {
  const ok = results.filter((r): r is Extract<BenchResult, { rtf: number }> => "rtf" in r && r.rtf > 0);
  const cpu = ok.find((r) => r.provider === "cpu");
  if (!cpu) return "cpu";
  const best = ok.reduce((a, b) => (b.rtf < a.rtf ? b : a), cpu);
  return best.rtf <= cpu.rtf * (1 - MIN_GAIN) ? best.provider : "cpu";
}

/** The providers this device has for the runtime `e` runs on. */
export const providersFor = (e: NativeEngine, d: DeviceProfile): Provider[] => (onOrt(e) ? d.ortProviders ?? [] : d.providers);

/** Everything a result depends on: the device (and so its thread count and
 *  runtime), the variant and its files on disk. O(files of the engine). */
export function benchKey(e: NativeEngine, d: DeviceProfile): string {
  const bytes = e.files.reduce((n, f) => { try { return n + statSync(join(engineDir(e.id), f)).size; } catch { return n; } }, 0);
  return `${e.id}|${bytes}|${fingerprint(d)}${onOrt(e) ? `|${d.ortRuntime}` : ""}`;
}

const FILE = resolve(DATA_DIR, "voice-accel.json");
let store: Store | null = null;
const get = (): Store => {
  if (store) return store;
  try { store = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null; } catch { /* unreadable: start over */ }
  store = { engines: {}, overrides: {}, ...store };
  return store;
};
/** Tmp file then rename, so a crash never leaves half a file. */
function save() {
  try {
    writeFileSync(`${FILE}.tmp`, JSON.stringify(store, null, 2));
    renameSync(`${FILE}.tmp`, FILE);
  } catch { /* read-only data dir: choices still hold for this run */ }
}

/** The last full probe (cached from a previous start), or node:os facts alone
 *  until the first probe of a fresh install lands. */
export const currentDevice = (): DeviceProfile => get().device ?? baseProfile();

/** Probes the device; a changed fingerprint makes every engine measure again,
 *  since their keys include it. */
export async function refreshDevice(probe = probeDevice): Promise<DeviceProfile> {
  const d = await probe();
  get().device = d;
  save();
  return d;
}

/** The finished benchmark for this engine, only while its key still holds. */
export function measured(e: NativeEngine): AccelEntry | undefined {
  const hit = get().engines[e.id];
  return hit?.results.length && hit.key === benchKey(e, currentDevice()) ? hit : undefined;
}

const failed = (m: AccelEntry | undefined, p: Provider) => !!m?.results.some((r) => r.provider === p && "error" in r);

/** The user's override when this device has that provider and it has not
 *  failed here; else the benchmark's choice; else CPU. */
export function accelFor(e: NativeEngine): Accel {
  const d = currentDevice(), m = measured(e), o = get().overrides[e.id];
  const provider = o && providersFor(e, d).includes(o) && !failed(m, o) ? o : m?.chosen ?? "cpu";
  return { provider, numThreads: threadsFor(d) };
}

/** Worth benchmarking: this device has an accelerator and no result stands. */
export const needsBench = (e: NativeEngine) => providersFor(e, currentDevice()).length > 1 && !measured(e);

/** Marks a benchmark as started; false when it should not run again. */
export function startBench(e: NativeEngine): boolean {
  const d = currentDevice(), key = benchKey(e, d), prev = get().engines[e.id];
  const attempts = prev?.key === key && !prev.results.length ? prev.attempts ?? 0 : 0;
  if (attempts >= MAX_ATTEMPTS) {
    finishBench(e, providersFor(e, d).filter((p) => p !== "cpu").map((provider) => ({ provider, error: `benchmark never finished in ${attempts} tries` })));
    return false;
  }
  get().engines[e.id] = { key, chosen: "cpu", results: [], at: new Date().toISOString(), attempts: attempts + 1 };
  save();
  return true;
}

/** Saves a benchmark's outcome; null (a call interrupted it, or the user asked
 *  for a fresh one) forgets the engine's result. */
export function finishBench(e: NativeEngine, results: BenchResult[] | null): AccelEntry | undefined {
  const entry = results ? { key: benchKey(e, currentDevice()), chosen: chooseProvider(results), results, at: new Date().toISOString() } : undefined;
  if (entry) get().engines[e.id] = entry;
  else delete get().engines[e.id];
  save();
  return entry;
}

/** A provider that failed during a real call is never used for this engine
 *  again on this device; the next load runs on CPU. */
export function markFailed(e: NativeEngine, provider: Provider, error: string): void {
  if (provider === "cpu") return;
  const prev = measured(e)?.results.filter((r) => r.provider !== provider) ?? [];
  finishBench(e, [...prev, { provider, error }]);
}

export function setOverride(e: NativeEngine, o: Override): void {
  if (o === "auto") delete get().overrides[e.id];
  else get().overrides[e.id] = o;
  save();
}

/** What GET /voice/perf shows for one engine. */
export function accelStatus(e: NativeEngine) {
  const m = measured(e);
  return { ...accelFor(e), providers: providersFor(e, currentDevice()), override: get().overrides[e.id] ?? ("auto" as Override), results: m?.results ?? [], measuredAt: m?.at };
}

// Fixed benchmark inputs. The ASR clip is synthetic (seeded noise under a
// syllable-like 4 Hz envelope), since not every archive ships a test clip; the
// encoder, which dominates the cost, runs the same on any audio of that length.
export const BENCH_TEXT = "The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking.";
export function benchAudio(seconds = 5): Float32Array {
  const out = new Float32Array(SAMPLE_RATE * seconds);
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    out[i] = ((seed / 2 ** 32) * 2 - 1) * 0.1 * Math.abs(Math.sin((Math.PI * 4 * i) / SAMPLE_RATE));
  }
  return out;
}
