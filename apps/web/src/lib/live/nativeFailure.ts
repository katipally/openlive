// Whether a native engine's failure would repeat on every call, so the session
// should stop trying that engine: it is not downloaded (409), the request can
// never be served (400), or no agent answers behind the web proxy (502). A
// timeout or a 500 is a one-off: that call falls back, the next tries again. Pure.
export function failureIsLasting(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 400 || status === 409 || status === 502;
}
