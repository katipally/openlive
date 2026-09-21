import { DEFAULT_FLOW_CONFIG } from "@openlive/flow-store";
import type { Approve, Risk, Tiers, Tool } from "./types.js";

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
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return async ({ tool, args, risk }, signal) => {
    if (tiers[tool.tier] === "deny") return { block: true, reason: `${tool.name} is turned off in settings.` };
    if (!wouldAsk(tiers, tool, risk)) return {};
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
export function wouldAsk(tiers: Tiers, tool: Tool, risk: Risk): boolean {
  const action = tiers[tool.tier];
  return action !== "deny" && (risk !== "safe" || action === "ask");
}
