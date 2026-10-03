import type { FlowConfig } from "./config";

// What Flow actually runs on where it can follow Chat. No node imports, so the
// renderer can use it too ("@openlive/flow-store/shared").

export type FlowBrain = Omit<FlowConfig["brain"], "override">;

/** Bounds on what Dictate's word lists may hold, so a hand-edited file cannot
 *  make every dictation slow or the settings file huge. */
export const DICTATE_LIMITS = { words: 2000, word: 80, snippets: 500, trigger: 80, text: 4000 } as const;

const CHAT_BRAIN: FlowBrain = { kind: "api", agentId: "", agentModel: "", agentEffort: "" };

/** The brain Flow thinks with: its own when the override is on, else Chat's
 *  default, which is API mode as set in Settings > Models. */
export const flowBrain = (cfg: Pick<FlowConfig, "brain">): FlowBrain => {
  if (!cfg.brain.override) return CHAT_BRAIN;
  const { override: _o, ...own } = cfg.brain;
  return own;
};

/** A brain picked for Flow, as the change to save: a coding agent is Flow's own,
 *  so the override goes on with it; API mode is the default Flow follows anyway. */
export const pickFlowBrain = (pick: Partial<FlowBrain>): Partial<FlowConfig["brain"]> =>
  ({ ...pick, override: pick.kind === "acp" });

/** The brain Dictate's AI polish and command mode think with: its own when
 *  its override is on, else Flow's. */
export const dictateBrain = (cfg: Pick<FlowConfig, "brain" | "dictate">): FlowBrain => {
  if (!cfg.dictate.brain.override) return flowBrain(cfg);
  const { override: _o, ...own } = cfg.dictate.brain;
  return own;
};

/** Flow's own wait before answering, or null when it follows the shared one.
 *  An undecided override (null, a config from before the two were shared)
 *  counts as on, so an existing Flow keeps the wait it had. */
export const flowTurn = (cfg: Pick<FlowConfig, "voice">): FlowConfig["voice"]["turn"] | null =>
  cfg.voice.turnOverride === false ? null : cfg.voice.turn;
