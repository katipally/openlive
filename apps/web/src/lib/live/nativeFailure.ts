// Whether a native engine's failure would repeat on every call, so the session
// should stop trying that engine: it is not downloaded (409), the request can
// never be served (400), what it names is gone (404: a deleted voice profile),
// or no agent answers behind the web proxy (502). A timeout or a 500 is a
// one-off, tried again. Pure.
export function failureIsLasting(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 400 || status === 404 || status === 409 || status === 502;
}

/** The engine is not downloaded (the agent's 409): an expected fallback that
 *  Settings and the call lobby offer to fix, not an error. Pure. */
export const notDownloaded = (err: unknown): boolean => (err as { status?: unknown } | null)?.status === 409;
