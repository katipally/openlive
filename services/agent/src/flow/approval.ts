import type { Approve } from "./types.js";

// Flow asks for one thing, once: may it act on this machine. After that every
// tool runs. There is no tier, no per-tool override and no per-call question,
// because a conversation interrupted three times to confirm a click is not a
// conversation, and a person who says yes to everything in a row has not been
// asked anything meaningful.

/** Nothing is ever asked. For tests and for a host that gates elsewhere. */
export const allowAll: Approve = async () => ({});

export interface ConsentOpts {
  /** Whether the person has already said Flow may act. Read per turn. */
  granted: () => boolean;
  /** Take consent out loud, for a machine that got past onboarding without it.
   *  Must not throw. */
  ask: (question: string, signal: AbortSignal) => Promise<boolean>;
  /** Remember the yes, so this is the last time it is asked. Must not throw. */
  remember: () => Promise<void>;
  /** An unanswered ask is a no: silence is not consent. */
  timeoutMs?: number;
}

export const CONSENT_QUESTION =
  "Before I do that: is it alright for me to act on this machine — type, click, and run things you ask for?";

// The model reads these as the tool's result, and a result that points at the
// settings has it telling a person who just said no to go and say yes.
const DECLINED = "the user declined this time, so it was not done. Do not retry it or ask them to allow it or turn anything on; carry on without it, unless they ask for it again.";
/** A tool result the user refused, told apart from one that failed. */
export const isDeclined = (result: string): boolean => result.includes(DECLINED);
const UNANSWERED = "the user did not answer the permission question, so it was not done. Do not retry it unless they ask for it again.";

/**
 * The whole policy. Consent already given runs the call; consent missing takes
 * it once and then runs the call; consent refused blocks every call of this
 * turn and asks again next turn, because a no here is about this moment, not
 * forever. Built per turn.
 */
export function consentApprove(opts: ConsentOpts): Approve {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  /** Resolves null when nobody answered. */
  let asking: Promise<boolean | null> | null = null;
  let refused = "";

  const take = (signal: AbortSignal): Promise<boolean | null> => {
    // A batch of calls is one question, not one per call.
    asking ??= (async () => {
      const inner = new AbortController();
      const onAbort = () => inner.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const yes = await Promise.race([
          opts.ask(CONSENT_QUESTION, inner.signal),
          new Promise<null>((resolve) => { timer = setTimeout(() => { inner.abort(); resolve(null); }, timeoutMs); }),
        ]);
        if (yes) await opts.remember();
        return yes;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        asking = null;
      }
    })();
    return asking;
  };

  return async (_req, signal) => {
    if (opts.granted()) return {};
    if (refused) return { block: true, reason: refused };
    if (signal.aborted) return { block: true, reason: "cancelled" };
    const yes = await take(signal);
    if (yes) return {};
    if (signal.aborted) return { block: true, reason: "cancelled" };
    refused = yes === null ? UNANSWERED : DECLINED;
    return { block: true, reason: refused };
  };
}
