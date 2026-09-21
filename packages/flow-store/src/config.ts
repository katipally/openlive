import { readFileSync, renameSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { configPath, ensureDir, flowDir } from "./paths";

// One versioned schema for everything Flow can be configured with. Two rules it
// must never break: every field has a default, and an unknown or missing key
// never fails the parse. Unknown keys survive a write untouched, so an older
// build cannot silently destroy a newer build's settings.

export const FLOW_CONFIG_VERSION = 1;

export type ActivationMode = "hold" | "toggle" | "ptt" | "hold_or_toggle";
export type InsertionMethod = "paste" | "type";
export type BrainKind = "openlive" | "acp";
export type RiskAction = "auto" | "ask" | "deny";
export type RiskTier = "read" | "insert" | "control" | "destructive";

const ACTIVATION_MODES = ["hold", "toggle", "ptt", "hold_or_toggle"] as const;
const INSERTION_METHODS = ["paste", "type"] as const;
const BRAIN_KINDS = ["openlive", "acp"] as const;
const RISK_ACTIONS = ["auto", "ask", "deny"] as const;

export interface FlowConfig {
  version: number;
  /** `+`-joined lowercase key names, modifier-only allowed. */
  binding: string;
  activation: ActivationMode;
  holdThresholdMs: number;
  insertion: {
    method: InsertionMethod;
    /** Some apps poll global keyboard state instead of reading the event flags. */
    modifierHoldMs: number;
    clipboardQuietMs: number;
    clipboardTimeoutMs: number;
  };
  brain: { kind: BrainKind; providerId: string; model: string; agentId: string };
  voice: {
    speakReplies: boolean;
    bargeIn: boolean;
    autoQuiet: { meetingApps: boolean; micContention: boolean; systemDnd: boolean; apps: string[] };
  };
  risk: Record<RiskTier, RiskAction>;
  /** Per-tool override on its tier, keyed by tool name. A tool in the
   *  `destructive` tier ignores its entry: that one always asks. */
  toolRisk: Record<string, RiskAction>;
  idleWindowMs: number;
  stt: { whisperSize: string };
  tts: { engine: string; voice: string; speed: number };
}

// AltGr lives on right alt everywhere but macOS, where right option is the
// idiomatic free modifier. Spelled in the addon's canonical vocabulary
// (`<group>_left` / `<group>_right`), which is what registerBinding parses.
const DEFAULT_BINDING = process.platform === "darwin" ? "option_right" : "ctrl_right";

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  version: FLOW_CONFIG_VERSION,
  binding: DEFAULT_BINDING,
  activation: "hold_or_toggle",
  holdThresholdMs: 250,
  insertion: { method: process.platform === "linux" ? "type" : "paste", modifierHoldMs: 100, clipboardQuietMs: 200, clipboardTimeoutMs: 8000 },
  brain: { kind: "openlive", providerId: "", model: "", agentId: "" },
  voice: {
    speakReplies: true,
    bargeIn: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
  },
  risk: { read: "auto", insert: "auto", control: "ask", destructive: "ask" },
  toolRisk: {},
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
const strings = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d);
const actions = (v: unknown): Record<string, RiskAction> => {
  const out: Record<string, RiskAction> = {};
  for (const [k, raw] of Object.entries(obj(v))) if (RISK_ACTIONS.includes(raw as RiskAction)) out[k] = raw as RiskAction;
  return out;
};

// Keyed on the version of the file being read: a v1 file runs MIGRATIONS[1] to
// become v2, and so on. Nothing to migrate yet; this is where a shipped schema
// change goes, so the frozen fixtures keep loading.
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

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
  const risk = obj(o.risk);
  const stt = obj(o.stt);
  const tts = obj(o.tts);
  return {
    ...o,
    version: FLOW_CONFIG_VERSION,
    binding: str(o.binding, d.binding),
    activation: one(o.activation, ACTIVATION_MODES, d.activation),
    holdThresholdMs: num(o.holdThresholdMs, d.holdThresholdMs),
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
      providerId: str(brain.providerId, d.brain.providerId),
      model: str(brain.model, d.brain.model),
      agentId: str(brain.agentId, d.brain.agentId),
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
    },
    risk: {
      ...risk,
      read: one(risk.read, RISK_ACTIONS, d.risk.read),
      insert: one(risk.insert, RISK_ACTIONS, d.risk.insert),
      control: one(risk.control, RISK_ACTIONS, d.risk.control),
      // Destructive always asks. A hand-edited "auto" here is not honoured, so
      // the setting on disk can never disagree with what Flow actually does.
      destructive: one(risk.destructive, RISK_ACTIONS, d.risk.destructive) === "deny" ? "deny" : "ask",
    },
    toolRisk: actions(o.toolRisk),
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
