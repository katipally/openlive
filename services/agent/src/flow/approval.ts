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

const DECLINED = "you have not given Flow permission to act on this machine yet. You can turn it on in Flow's settings.";

/**
 * The whole policy. Consent already given runs the call; consent missing takes
 * it once and then runs the call; consent refused blocks this call and asks
 * again next time, because a no here is about this moment, not forever.
 */
export function consentApprove(opts: ConsentOpts): Approve {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let asking: Promise<boolean> | null = null;

  const take = (signal: AbortSignal): Promise<boolean> => {
    // A batch of calls is one question, not one per call.
    asking ??= (async () => {
      const inner = new AbortController();
      const onAbort = () => inner.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const yes = await Promise.race([
          opts.ask(CONSENT_QUESTION, inner.signal),
          new Promise<false>((resolve) => { timer = setTimeout(() => { inner.abort(); resolve(false); }, timeoutMs); }),
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
    if (signal.aborted) return { block: true, reason: "cancelled" };
    return (await take(signal)) ? {} : { block: true, reason: DECLINED };
  };
}
