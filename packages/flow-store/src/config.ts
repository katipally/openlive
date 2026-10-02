import { readFileSync, renameSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { configPath, ensureDir, flowDir } from "./paths";
import { DICTATE_LIMITS } from "./shared";

// One versioned schema for everything Flow can be configured with. Two rules it
// must never break: every field has a default, and an unknown or missing key
// never fails the parse. Unknown keys survive a write untouched, so an older
// build cannot silently destroy a newer build's settings.

export const FLOW_CONFIG_VERSION = 8;

export type InsertionMethod = "paste" | "type";
export type BrainKind = "api" | "acp";
export type DictateTone = "natural" | "casual" | "formal";
export type DictateKeep = "off" | "day" | "week" | "month" | "forever";

const INSERTION_METHODS = ["paste", "type"] as const;
const BRAIN_KINDS = ["api", "acp"] as const;
const TONES = ["natural", "casual", "formal"] as const;
const KEEPS = ["off", "day", "week", "month", "forever"] as const;

export interface FlowConfig {
  version: number;
  insertion: {
    method: InsertionMethod;
    /** Some apps poll global keyboard state instead of reading the event flags. */
    modifierHoldMs: number;
    clipboardQuietMs: number;
    clipboardTimeoutMs: number;
    /** Off, a paste leaves its text on the clipboard instead of putting the user's copy back. */
    restoreClipboard: boolean;
  };
  /** Flow's own brain, used only while `override` is on; off, Flow thinks as
   *  Chat does (flowBrain in shared.ts). API mode has no fields here: it uses
   *  the provider, model and effort Chat does, set once in Settings > Models.
   *  `agentModel` is the coding agent's own, which only that agent can name.
   *  `agentEffort` is how hard it thinks; "" is the agent's own default, which
   *  is the lowest it offers. */
  brain: {
    override: boolean;
    kind: BrainKind;
    agentId: string;
    agentModel: string;
    agentEffort: string;
  };
  voice: {
    speakReplies: boolean;
    autoQuiet: { meetingApps: boolean; micContention: boolean; systemDnd: boolean; apps: string[] };
    /** Flow's own wait for the rest of a sentence before answering the half it
     *  has, used only while `turnOverride` is on; off, Flow waits as Chat does
     *  (flowTurn in shared.ts). Patient when first turned on: in a call a person
     *  who is cut off can see it happen and press a key, and hands-free they
     *  cannot. `threshold` is how sure the end-of-turn model must be, `holdMs`
     *  how long a trailing-off sentence is held, `redemptionMs` the silence the
     *  VAD waits through. */
    turn: { threshold: number; holdMs: number; redemptionMs: number };
    /** null: not decided yet, for a config from before the wait was shared.
     *  Only the renderer holds Chat's wait to compare with, so it decides. */
    turnOverride: boolean | null;
  };
  /** The one permission Flow ever takes: the person said, once, that it may act
   *  on this machine. Nothing is asked per tool, per tier or per call. */
  consent: { granted: boolean; at: string };
  idleWindowMs: number;
  /** Talk instead of type: hold `hotkey` and the cleaned-up words go in at the
   *  cursor, with no brain. `hotkey` is in ol-input's binding grammar. Each
   *  cleanup rule runs on this machine. `brain` is the one AI polish and
   *  command mode think with; off, they use Flow's. `polish` rewrites what
   *  was said with that brain; `commandHotkey` held says what to do with the
   *  selection instead. `words` are spelled as written, a snippet's trigger
   *  said alone types its text, and `history` is how long dictations are kept. */
  dictate: {
    enabled: boolean;
    hotkey: string;
    cleanup: { punctuation: boolean; fillers: boolean; backtrack: boolean; lists: boolean; numbers: boolean };
    brain: FlowConfig["brain"];
    polish: { enabled: boolean; tone: DictateTone };
    commandHotkey: string;
    commands: { enter: boolean; newLine: boolean; newParagraph: boolean; undo: boolean; stop: boolean };
    words: string[];
    snippets: { trigger: string; text: string }[];
    history: DictateKeep;
  };
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  version: FLOW_CONFIG_VERSION,
  insertion: { method: process.platform === "linux" ? "type" : "paste", modifierHoldMs: 50, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: true },
  brain: { override: false, kind: "api", agentId: "", agentModel: "", agentEffort: "" },
  voice: {
    speakReplies: true,
    autoQuiet: { meetingApps: true, micContention: true, systemDnd: true, apps: [] },
    turn: { threshold: 0.65, holdMs: 6000, redemptionMs: 800 },
    turnOverride: false,
  },
  consent: { granted: false, at: "" },
  idleWindowMs: 5 * 60_000,
  dictate: {
    enabled: false,
    hotkey: "option_right",
    cleanup: { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true },
    brain: { override: false, kind: "api", agentId: "", agentModel: "", agentEffort: "" },
    polish: { enabled: false, tone: "natural" },
    commandHotkey: "shift+option_right",
    commands: { enter: true, newLine: true, newParagraph: true, undo: true, stop: true },
    words: [],
    snippets: [],
    history: "month",
  },
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
  // v5 kept its own speech-to-text and voice settings. v6 uses the shared voice
  // pipeline, so both are dropped rather than carried through as settings
  // nothing reads.
  5: ({ stt: _s, tts: _t, ...rest }) => rest,
  // v6 always used Flow's own brain and wait. v7 shares Chat's unless an
  // override is on, so a v6 Flow keeps what it ran on: a coding agent brain
  // turns the brain override on (an API brain already was Chat's), and the
  // wait override is left for the renderer to decide against Chat's wait.
  6: (raw) => {
    const brain = obj(raw.brain);
    return { ...raw, brain: { ...brain, override: brain.kind === "acp" }, voice: { ...obj(raw.voice), turnOverride: null } };
  },
  // v7 held a paste's modifiers 100 ms by default; v8's default is 50. A file
  // still on the old default moves with it, and any other value was chosen.
  7: (raw) => {
    const insertion = obj(raw.insertion);
    return insertion.modifierHoldMs === 100 ? { ...raw, insertion: { ...insertion, modifierHoldMs: 50 } } : raw;
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
  const dictate = obj(o.dictate);
  const cleanup = obj(dictate.cleanup);
  const dictateBrain = obj(dictate.brain);
  const polish = obj(dictate.polish);
  const commands = obj(dictate.commands);
  const dd = d.dictate;
  return {
    ...o,
    version: FLOW_CONFIG_VERSION,
    insertion: {
      ...insertion,
      method: one(insertion.method, INSERTION_METHODS, d.insertion.method),
      modifierHoldMs: num(insertion.modifierHoldMs, d.insertion.modifierHoldMs),
      clipboardQuietMs: num(insertion.clipboardQuietMs, d.insertion.clipboardQuietMs),
      clipboardTimeoutMs: num(insertion.clipboardTimeoutMs, d.insertion.clipboardTimeoutMs),
      restoreClipboard: bool(insertion.restoreClipboard, d.insertion.restoreClipboard),
    },
    brain: {
      ...brain,
      override: bool(brain.override, d.brain.override),
      kind: one(brain.kind, BRAIN_KINDS, d.brain.kind),
      agentId: str(brain.agentId, d.brain.agentId),
      agentModel: str(brain.agentModel, d.brain.agentModel),
      agentEffort: str(brain.agentEffort, d.brain.agentEffort),
    },
    voice: {
      ...voice,
      speakReplies: bool(voice.speakReplies, d.voice.speakReplies),
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
      turnOverride: voice.turnOverride === null ? null : bool(voice.turnOverride, d.voice.turnOverride as boolean),
    },
    // A grant with no date is still a grant, but a date with no grant is not:
    // the stamp is what the settings screen shows back to the person.
    consent: {
      ...consent,
      granted: bool(consent.granted, d.consent.granted),
      at: str(consent.at, d.consent.at),
    },
    idleWindowMs: num(o.idleWindowMs, d.idleWindowMs, 1),
    dictate: {
      ...dictate,
      enabled: bool(dictate.enabled, dd.enabled),
      hotkey: str(dictate.hotkey, dd.hotkey).trim() || dd.hotkey,
      cleanup: {
        ...cleanup,
        punctuation: bool(cleanup.punctuation, dd.cleanup.punctuation),
        fillers: bool(cleanup.fillers, dd.cleanup.fillers),
        backtrack: bool(cleanup.backtrack, dd.cleanup.backtrack),
        lists: bool(cleanup.lists, dd.cleanup.lists),
        numbers: bool(cleanup.numbers, dd.cleanup.numbers),
      },
      brain: {
        ...dictateBrain,
        override: bool(dictateBrain.override, dd.brain.override),
        kind: one(dictateBrain.kind, BRAIN_KINDS, dd.brain.kind),
        agentId: str(dictateBrain.agentId, dd.brain.agentId),
        agentModel: str(dictateBrain.agentModel, dd.brain.agentModel),
        agentEffort: str(dictateBrain.agentEffort, dd.brain.agentEffort),
      },
      polish: { ...polish, enabled: bool(polish.enabled, dd.polish.enabled), tone: one(polish.tone, TONES, dd.polish.tone) },
      commandHotkey: str(dictate.commandHotkey, dd.commandHotkey).trim() || dd.commandHotkey,
      commands: {
        ...commands,
        enter: bool(commands.enter, dd.commands.enter),
        newLine: bool(commands.newLine, dd.commands.newLine),
        newParagraph: bool(commands.newParagraph, dd.commands.newParagraph),
        undo: bool(commands.undo, dd.commands.undo),
        stop: bool(commands.stop, dd.commands.stop),
      },
      words: strings(dictate.words, dd.words).map((w) => w.trim().slice(0, DICTATE_LIMITS.word)).filter(Boolean).slice(0, DICTATE_LIMITS.words),
      snippets: (Array.isArray(dictate.snippets) ? dictate.snippets : []).map(obj)
        .map((x) => ({ trigger: str(x.trigger, "").trim().slice(0, DICTATE_LIMITS.trigger), text: str(x.text, "").slice(0, DICTATE_LIMITS.text) }))
        .filter((x) => x.trigger && x.text).slice(0, DICTATE_LIMITS.snippets),
      history: one(dictate.history, KEEPS, dd.history),
    },
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
