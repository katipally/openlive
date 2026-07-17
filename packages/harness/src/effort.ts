import type { Effort } from "./types"

/** Map a reasoning effort level to a thinking token budget (legacy Anthropic form). */
export function thinkingBudget(effort?: Effort): number {
  switch (effort) {
    case "low":
      return 2048
    case "medium":
      return 4096
    case "high":
      return 8192
    case "xhigh":
      return 12288
    case "max":
      return 16384
    default:
      return 0
  }
}

/** OpenAI's `reasoning.effort` only accepts low/medium/high — collapse the top two. */
export const EFFORT_MAP: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
}

/** How a Claude model accepts extended thinking, or "none" when it has no thinking
 *  channel (or rejects the param). Single source of truth for both isReasoningModel
 *  (so the effort picker isn't dead on Anthropic) and anthropic.ts (so we never send
 *  a form the model 400s on). Verified against the Claude API model matrix, July 2026:
 *    • adaptive + output_config.effort → Opus 4.6/4.7/4.8, Sonnet 4.6, Sonnet 5, Fable/Mythos 5
 *    • legacy budget_tokens            → Claude 3.7, Opus 4.0/4.1/4.5, Sonnet 4.0/4.5
 *    • none (rejects thinking/effort)  → Haiku (incl. 4.5, the default live rec), Claude 3.5/older */
export function anthropicThinkingForm(id: string): "adaptive" | "budget" | "none" {
  const m = id.toLowerCase()
  if (/haiku|claude-3-5|claude-3-0|claude-2/.test(m)) return "none"
  if (/opus-4-[6789]|opus-5|sonnet-4-[6789]|sonnet-5|fable-5|mythos-5/.test(m)) return "adaptive"
  if (/claude-3-7|opus-4-[015]|sonnet-4-[05]/.test(m)) return "budget"
  return "none" // unknown claude id → safest is no thinking (never a spurious 400)
}

/** Does a model id look like it exposes a reasoning/thinking channel? Single
 *  source of truth (was copy-pasted in models.ts and the live turn runner). */
export function isReasoningModel(id: string): boolean {
  if (/claude/i.test(id)) return anthropicThinkingForm(id) !== "none"
  return /(^|[-/])(o\d|gpt-5|gpt-6)|reason|think|deepseek-r|r1|qwq|magistral|minimax-m/i.test(id)
}
