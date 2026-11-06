import { AGENT_REGISTRY, type AgentId } from "./agent-registry";
import { ClassedError } from "./error-class";

// Why a coding agent did not come up, as a closed set. Only the reason crosses a
// process boundary (`brain_error.start_reason`); the words stay on the machine.
export const START_REASONS = ["not_installed", "auth_needed", "personal_account", "outdated", "timeout", "exited"] as const;
export type StartReason = (typeof START_REASONS)[number];

// Wording checked 2026-11-06: Gemini CLI's "This client is no longer supported for Gemini Code Assist
// for individuals" (gemini-cli issue 28229) and the 403 "Eligibility check failed: PERMISSION_DENIED"
// (discussion 28017); an org-only gate answers a personal account with "named user on your
// organization's Gemini Code Assist Standard edition subscription".
const PERSONAL_ACCOUNT = /no longer supported for Gemini Code Assist|Eligibility check failed|disabled in this account for violation|named user on your organization/i;
const AUTH_NEEDED = /not (logged|signed) in|please (log|sign) ?in|authentication (is )?(required|failed)|unauthori[sz]ed|invalid api key|(missing|no) api key|no (model )?provider|please set an auth method|auth_required/i;
const OUTDATED = /unknown (option|argument|command)|unrecognized (option|argument)|invalid (option|argument)/i;
const NOT_INSTALLED = /command not found|not recognized as an internal or external command|spawn \S+ ENOENT/i;
// A shell's "command not found": 127 on POSIX, 9009 from cmd.exe.
const NOT_FOUND_EXIT = new Set([127, 9009]);

/** The coarse reason an agent died or refused to start, from its exit code and what it printed. */
export function startReason(text: string, exitCode?: number | null): StartReason {
  if (PERSONAL_ACCOUNT.test(text)) return "personal_account";
  if (AUTH_NEEDED.test(text)) return "auth_needed";
  if (OUTDATED.test(text)) return "outdated";
  if (NOT_INSTALLED.test(text) || (exitCode != null && NOT_FOUND_EXIT.has(exitCode))) return "not_installed";
  return "exited";
}

/** A start that failed, with the reason that picked its words. */
export class AgentStartError extends ClassedError {
  constructor(message: string, readonly reason: StartReason) { super(message, reason === "timeout" ? "agent_start_timeout" : "agent_start_failed"); }
}

export const startReasonOf = (e: unknown): StartReason | undefined => (e instanceof AgentStartError ? e.reason : undefined);

/** What a person should read and do about a failed start. `command` is the binary that was
 *  missing, `tail` the last of the agent's own output. */
export function startMessage(id: AgentId, reason: StartReason, o: { command?: string; code?: number | null; seconds?: number; tail?: string } = {}): string {
  const { label, login, wizard, startHint } = AGENT_REGISTRY[id];
  const tail = o.tail ? ` ${o.tail}` : "";
  switch (reason) {
    case "not_installed":
      return o.command === "npx"
        ? `${label} needs Node.js (npx) to start. Install Node.js, then retry.`
        : `${label} isn't installed. Install it from Settings → Agents, then retry.`;
    case "auth_needed":
      return wizard
        ? `${label} needs setup: run \`${login}\` in a terminal and pick a provider, then retry.${tail}`
        : `${label} needs you to sign in: run \`${login}\` in a terminal, then retry.${tail}`;
    case "personal_account":
      return `${label} can't use your personal Google account: Google ended Gemini Code Assist for individuals and refuses the sign-in. Use a Gemini API key instead: create one at aistudio.google.com/apikey, set GEMINI_API_KEY (for example in ~/.gemini/.env), then retry. If it still asks for Google sign-in, run \`gemini\` once and pick the API key option.`;
    case "outdated":
      return `${label} is too old to talk to OpenLive. Update it, then retry. ${startHint}${tail}`;
    case "timeout":
      return `${label} didn't answer within ${o.seconds ?? 0}s. It may still be starting; retry, and if it keeps happening run it in a terminal to see what it says.`;
    case "exited":
      return `${label} exited before connecting${o.code != null ? ` (code ${o.code})` : ""}. ${startHint}${tail}`;
  }
}

export const startFailure = (id: AgentId, reason: StartReason, o?: Parameters<typeof startMessage>[2]): AgentStartError =>
  new AgentStartError(startMessage(id, reason, o), reason);
