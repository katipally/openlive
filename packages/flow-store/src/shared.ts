import { isAgentId } from "@openlive/shared";
import type { FlowConfig } from "./config";

// What Flow actually runs on where it can follow the default. No node imports, so the
// renderer can use it too ("@openlive/flow-store/shared").

export type FlowBrain = Omit<FlowConfig["brain"], "override">;

/** Bounds on what Dictate's word lists may hold, so a hand-edited file cannot
 *  make every dictation slow or the settings file huge. */
export const DICTATE_LIMITS = { words: 2000, word: 80, snippets: 500, trigger: 80, text: 4000 } as const;

/** Push to talk's key where nothing has been picked: Fn on a Mac, Right Ctrl
 *  elsewhere, where Fn never reaches the OS. */
export const defaultPttKey = (platform: string): string => (platform === "darwin" ? "fn" : "ctrl_right");

const SIDED_MODIFIER = /^(ctrl|option|shift|command)_(left|right)$/;
const SPARE_KEY = /^f(1[3-9]|2[0-4])$/;

/** A push-to-talk key: one physical key that types nothing. A side of a
 *  modifier (a bare group would leave no side for the toggles), Fn on a Mac,
 *  or F13 to F24. */
export const pttKeyOk = (key: unknown, platform: string): key is string =>
  typeof key === "string" && (SIDED_MODIFIER.test(key) || SPARE_KEY.test(key) || (key === "fn" && platform === "darwin"));

/** A key Flow or Dictate double-taps: a modifier group, either side or one, Fn
 *  on a Mac, or F13 to F24. */
export const toggleKeyOk = (key: unknown, platform: string): key is string =>
  typeof key === "string" && (/^(ctrl|option|shift|command)$/.test(key) || pttKeyOk(key, platform));

const MODIFIER = /^(ctrl|option|shift|command)(?:_(left|right))?$/;

/** `toggle` as the hook watches it while `hold` is the push-to-talk key: it
 *  gives up the side push to talk holds ("ctrl" beside "ctrl_right" is
 *  "ctrl_left"), and is null when push to talk takes all of it. ol-input's
 *  `narrowToggle`, for the one-key bindings these validators allow. */
export function narrowToggle(toggle: string, hold: string): string | null {
  if (toggle === hold) return null;
  const t = MODIFIER.exec(toggle);
  const h = MODIFIER.exec(hold);
  if (!t || !h || t[1] !== h[1]) return toggle;
  if (!h[2]) return null;
  if (t[2]) return t[2] === h[2] ? null : toggle;
  return `${t[1]}_${h[2] === "left" ? "right" : "left"}`;
}

/** Whether two double-tap keys share a physical key ("ctrl" and "ctrl_left" do). */
export function sameKey(a: string, b: string): boolean {
  if (a === b) return true;
  const x = MODIFIER.exec(a);
  const y = MODIFIER.exec(b);
  return !!x && !!y && x[1] === y[1] && (!x[2] || !y[2] || x[2] === y[2]);
}

const API_BRAIN: FlowBrain = { kind: "api", agentId: "", agentModel: "", agentEffort: "" };

/** The settings.json keys (packages/db) that say who answers by default: a
 *  coding agent's id, or none for the API key set in Settings > Models. New
 *  chats, Flow and Dictate start from it. Unset is the API key, which is what
 *  every build before these keys ran on, so no file needs migrating. */
export type DefaultBrainSettings = { defaultAgent?: string; defaultAgentModel?: string; defaultAgentEffort?: string };

/** Who answers by default. An id this build does not know answers with the API key. */
export const defaultBrain = (s: DefaultBrainSettings): FlowBrain =>
  isAgentId(s.defaultAgent) ? { kind: "acp", agentId: s.defaultAgent, agentModel: s.defaultAgentModel ?? "", agentEffort: s.defaultAgentEffort ?? "" } : API_BRAIN;

/** The default as the settings that hold it. */
export const defaultBrainSettings = (b: FlowBrain): Required<DefaultBrainSettings> =>
  b.kind === "acp" ? { defaultAgent: b.agentId, defaultAgentModel: b.agentModel, defaultAgentEffort: b.agentEffort }
    : { defaultAgent: "", defaultAgentModel: "", defaultAgentEffort: "" };

/** Who answers in Flow: its own when the override is on, else the default. */
export const flowBrain = (cfg: Pick<FlowConfig, "brain">, settings: DefaultBrainSettings): FlowBrain => {
  if (!cfg.brain.override) return defaultBrain(settings);
  const { override: _o, ...own } = cfg.brain;
  return own;
};

/** Who answers Dictate's AI polish and command mode: its own when its
 *  override is on, else Flow's. */
export const dictateBrain = (cfg: Pick<FlowConfig, "brain" | "dictate">, settings: DefaultBrainSettings): FlowBrain => {
  if (!cfg.dictate.brain.override) return flowBrain(cfg, settings);
  const { override: _o, ...own } = cfg.dictate.brain;
  return own;
};

/** Flow's own wait before answering, or null when it follows the shared one.
 *  An undecided override (null, a config from before the two were shared)
 *  counts as on, so an existing Flow keeps the wait it had. */
export const flowTurn = (cfg: Pick<FlowConfig, "voice">): FlowConfig["voice"]["turn"] | null =>
  cfg.voice.turnOverride === false ? null : cfg.voice.turn;
