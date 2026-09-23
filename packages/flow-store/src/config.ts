import { readFileSync, renameSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { configPath, ensureDir, flowDir } from "./paths";

// One versioned schema for everything Flow can be configured with. Two rules it
// must never break: every field has a default, and an unknown or missing key
// never fails the parse. Unknown keys survive a write untouched, so an older
// build cannot silently destroy a newer build's settings.

export const FLOW_CONFIG_VERSION = 5;

export type InsertionMethod = "paste" | "type";
export type BrainKind = "api" | "acp";

const INSERTION_METHODS = ["paste", "type"] as const;
const BRAIN_KINDS = ["api", "acp"] as const;

export interface FlowConfig {
  version: number;
  insertion: {
    method: InsertionMethod;
    /** Some apps poll global keyboard state instead of reading the event flags. */
    modifierHoldMs: number;
    clipboardQuietMs: number;
    clipboardTimeoutMs: number;
  };
  /** API mode has no fields here: it uses the provider, model and effort Chat
   *  does, set once in Settings > Models. `agentModel` is the coding agent's
   *  own, which only that agent can name. `agentEffort` is how hard it thinks;
   *  "" is the agent's own default, which is the lowest it offers. */
  brain: {
    kind: BrainKind;
    agentId: string;
    agentModel: string;
    agentEffort: string;
  };
  voice: {
    speakReplies: boolean;
    bargeIn: boolean;
    autoQuiet: { meetingApps: boolean; micContention: boolean; systemDnd: boolean; apps: string[] };
    /** How long Flow waits for the rest of a sentence before answering the half
     *  it has. Its own, and patient by default: in a call a person who is cut
     *  off can see it happen and press a key, and hands-free they cannot, so a
     *  sentence sent early is answered and acted on before they finish saying
     *  it. `threshold` is how sure the end-of-turn model must be, `holdMs` how
     *  long a trailing-off sentence is held, `redemptionMs` the silence the VAD
     *  waits through. */
    turn: { threshold: number; holdMs: number; redemptionMs: number };
  };
  /** The one permission Flow ever takes: the person said, once, that it may act
   *  on this machine. Nothing is asked per tool, per tier or per call. */
  consent: { granted: boolean; at: string };
  idleWindowMs: number;
  stt: { whisperSize: string };
  tts: { engine: string; voice: string; speed: number };
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  version: FLOW_CONFIG_VERSION,
  insertion: { method: process.platform === "linux" ? "type" : "paste", modifierHoldMs: 100, clipboardQuietMs: 200, clipboardTimeoutMs: 8000 },
  brain: { kind: "api", agentId: "", agentModel: "", agentEffort: "" },
  voice: {
    speakReplies: true,
    bargeIn: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
    turn: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 },
  },
  consent: { granted: false, at: "" },
  idleWindowMs: 5 * 60_000,
  stt: { whisperSize: "base" },
  tts: { engine: "kokoro", voice: "af_heart", speed: 1 },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d);
const one = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const strings = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d);

// Keyed on the version of the file being read: a v1 file runs MIGRATIONS[1] to
// become v2, and so on.
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 let the trigger be any key in any of four activation modes. v2 has one
  // gesture, so the three fields that configured it are dropped rather than
  // carried through as settings nothing reads.
  1: ({ binding: _b, activation: _a, holdThresholdMs: _h, ...rest }) => rest,
  // v2 asked per tier and per tool, out loud, mid-sentence. v3 asks once, in
  // onboarding, so the tiers and the overrides are dropped rather than carried
  // through as settings nothing reads. A machine that was already set up keeps
  // working: consent is taken on the first tool call instead.
  2: ({ risk: _r, toolRisk: _t, ...rest }) => rest,
  // v3 called the built-in brain "openlive"; v4 calls it "api".
  3: (raw) => {
    const brain = obj(raw.brain);
    return brain.kind === "openlive" ? { ...raw, brain: { ...brain, kind: "api" } } : raw;
  },
  // v4 let Flow pick its own API-mode provider, model and effort. v5 shares
  // Chat's, so the three are dropped rather than carried through as settings
  // nothing reads.
  4: ({ brain, ...rest }) => {
    if (!isObj(brain)) return rest;
    const { providerId: _p, model: _m, effort: _e, ...kept } = brain;
    return { ...rest, brain: kept };
  },
};

/** Never throws. Anything unrecognised falls back to its default, and any key
 *  this build does not know about is carried through untouched. */
export function parseFlowConfig(raw: unknown): FlowConfig {
  let o = obj(raw);
  for (let v = num(o.version, FLOW_CONFIG_VERSION); v < FLOW_CONFIG_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) break;
    o = obj(migrate(o));
  }
  const d = DEFAULT_FLOW_CONFIG;
  const insertion = obj(o.insertion);
  const brain = obj(o.brain);
  const voice = obj(o.voice);
  const autoQuiet = obj(voice.autoQuiet);
  const turn = obj(voice.turn);
  const consent = obj(o.consent);
  const stt = obj(o.stt);
  const tts = obj(o.tts);
  return {
    ...o,
    version: FLOW_CONFIG_VERSION,
    insertion: {
      ...insertion,
      method: one(insertion.method, INSERTION_METHODS, d.insertion.method),
      modifierHoldMs: num(insertion.modifierHoldMs, d.insertion.modifierHoldMs),
      clipboardQuietMs: num(insertion.clipboardQuietMs, d.insertion.clipboardQuietMs),
      clipboardTimeoutMs: num(insertion.clipboardTimeoutMs, d.insertion.clipboardTimeoutMs),
    },
    brain: {
      ...brain,
      kind: one(brain.kind, BRAIN_KINDS, d.brain.kind),
      agentId: str(brain.agentId, d.brain.agentId),
      agentModel: str(brain.agentModel, d.brain.agentModel),
      agentEffort: str(brain.agentEffort, d.brain.agentEffort),
    },
    voice: {
      ...voice,
      speakReplies: bool(voice.speakReplies, d.voice.speakReplies),
      bargeIn: bool(voice.bargeIn, d.voice.bargeIn),
      autoQuiet: {
        ...autoQuiet,
        meetingApps: bool(autoQuiet.meetingApps, d.voice.autoQuiet.meetingApps),
        micContention: bool(autoQuiet.micContention, d.voice.autoQuiet.micContention),
        systemDnd: bool(autoQuiet.systemDnd, d.voice.autoQuiet.systemDnd),
        apps: strings(autoQuiet.apps, d.voice.autoQuiet.apps),
      },
      // Clamped to the same ranges the voice pipeline accepts, because these
      // numbers are handed straight to it.
      turn: {
        ...turn,
        threshold: clamp(num(turn.threshold, d.voice.turn.threshold), 0, 1),
        holdMs: clamp(num(turn.holdMs, d.voice.turn.holdMs), 1000, 8000),
        redemptionMs: clamp(num(turn.redemptionMs, d.voice.turn.redemptionMs), 200, 1500),
      },
    },
    // A grant with no date is still a grant, but a date with no grant is not:
    // the stamp is what the settings screen shows back to the person.
    consent: {
      ...consent,
      granted: bool(consent.granted, d.consent.granted),
      at: str(consent.at, d.consent.at),
    },
    idleWindowMs: num(o.idleWindowMs, d.idleWindowMs, 1),
    stt: { ...stt, whisperSize: str(stt.whisperSize, d.stt.whisperSize) },
    tts: { ...tts, engine: str(tts.engine, d.tts.engine), voice: str(tts.voice, d.tts.voice), speed: num(tts.speed, d.tts.speed, 0.1) },
  };
}

export function readFlowConfig(): FlowConfig {
  try { return parseFlowConfig(JSON.parse(readFileSync(configPath(), "utf8"))); }
  catch { return parseFlowConfig({}); }
}

function writeConfig(cfg: FlowConfig): void {
  const path = configPath();
  ensureDir(flowDir());
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path); // atomic on the same filesystem
}

// Same lock discipline as packages/db/src/store.ts: same-process writers queue on
// the in-process chain, and the lockfile only has to arbitrate between the main
// process and the agent service. `update` keeps a slow holder from being judged
// stale, `stale` still self-heals after a kill.
let chain: Promise<unknown> = Promise.resolve();

/** Cross-process-safe read-modify-write. The whole read to write cycle is held,
 *  so the main process and the agent service cannot lose each other's changes. */
export function updateFlowConfig(fn: (cur: FlowConfig) => FlowConfig | Promise<FlowConfig>): Promise<FlowConfig> {
  const run = chain.catch(() => {}).then(async () => {
    ensureDir(flowDir());
    const release = await lockfile.lock(configPath(), {
      realpath: false,
      stale: 15000,
      update: 2500,
      retries: { retries: 15, minTimeout: 15, maxTimeout: 250 },
    });
    try {
      const next = parseFlowConfig(await fn(readFlowConfig()));
      writeConfig(next);
      return next;
    } finally {
      await release();
    }
  });
  chain = run;
  return run;
}
