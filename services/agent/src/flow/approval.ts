import { DEFAULT_FLOW_CONFIG } from "@openlive/flow-store";
import type { Approve, Risk, RiskAction, Tiers, Tool } from "./types.js";

// Risk is two pieces of data meeting: the tier a tool belongs to, which the user
// configures, and the risk of this particular call, which the tool decides from
// its own arguments. There is no rule engine and there is nothing else to read.

export const DEFAULT_TIERS: Tiers = DEFAULT_FLOW_CONFIG.risk;

/** Nothing is ever asked. For tests and for a host that gates elsewhere. */
export const allowAll: Approve = async () => ({});

export type AskUser = (question: string, signal: AbortSignal) => Promise<boolean>;

export interface VoiceApprovalOpts {
  /** From the user's Flow config. */
  tiers?: Tiers;
  /** Per-tool overrides on those tiers, from the same config. */
  perTool?: Record<string, RiskAction>;
  /** Speak the action and wait for a yes or a no. Must not throw. */
  ask: AskUser;
  /** An unanswered `confirm` resolves to a block: silence is not consent. */
  timeoutMs?: number;
}

const question = (tool: Tool, args: unknown): string => {
  const detail = typeof (args as { text?: unknown })?.text === "string"
    ? ` "${String((args as { text: string }).text).slice(0, 80)}"`
    : "";
  return `Can I ${tool.name.replace(/_/g, " ")}${detail}?`;
};

/**
 * The voice policy: `safe` runs, `confirm` asks and blocks if the answer does
 * not come, `dangerous` always asks whatever the tier is set to. Asking out loud
 * costs the user a whole conversational turn, so it is reserved for the two
 * tiers that earn it.
 */
export function voiceApprove(opts: VoiceApprovalOpts): Approve {
  const tiers = opts.tiers ?? DEFAULT_TIERS;
  const perTool = opts.perTool ?? {};
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return async ({ tool, args, risk }, signal) => {
    if (actionFor(tiers, perTool, tool) === "deny") return { block: true, reason: `${tool.name} is turned off in settings.` };
    if (!wouldAsk(tiers, tool, risk, perTool)) return {};
    if (signal.aborted) return { block: true, reason: "cancelled" };

    const inner = new AbortController();
    const onAbort = () => inner.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answered = await Promise.race([
        opts.ask(question(tool, args), inner.signal),
        new Promise<false>((resolve) => { timer = setTimeout(() => { inner.abort(); resolve(false); }, timeoutMs); }),
      ]);
      return answered ? {} : { block: true, reason: "the user did not approve this" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * What the policy would do, without asking. For a UI that wants to show the tier.
 *
 * The tier can only raise the bar or shut a tool off: a user who set a tier to
 * `auto` was asking not to be interrupted about routine calls, not to hand over
 * the ones the tool itself flagged.
 */
export function wouldAsk(tiers: Tiers, tool: Tool, risk: Risk, perTool: Record<string, RiskAction> = {}): boolean {
  if (tool.tier === "destructive") return actionFor(tiers, perTool, tool) !== "deny";
  const action = actionFor(tiers, perTool, tool);
  return action !== "deny" && (risk !== "safe" || action === "ask");
}

/** The tool's own setting when it has one, else its tier's. Destructive tools
 *  cannot be lowered to `auto` from either place. */
export function actionFor(tiers: Tiers, perTool: Record<string, RiskAction>, tool: Tool): RiskAction {
  const action = perTool[tool.name] ?? tiers[tool.tier];
  return tool.tier === "destructive" && action === "auto" ? "ask" : action;
}
