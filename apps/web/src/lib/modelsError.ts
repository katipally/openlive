export type ModelsFailure = { status: number; reason: "key_rejected" | "timeout" | "network" | "upstream"; error: string };

/** Why a provider's model list could not load, as an HTTP status plus a short
 *  line the model pickers show in place of the list. */
export function classifyModelsError(e: unknown): ModelsFailure {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return { status: 504, reason: "timeout", error: "The provider took too long to answer." };
  const http = /HTTP (\d{3})/.exec(err?.message ?? "");
  const code = http ? Number(http[1]) : 0;
  if (code === 401 || code === 403) return { status: 401, reason: "key_rejected", error: "The provider rejected this key." };
  if (code) return { status: 502, reason: "upstream", error: `The provider answered with an error (${code}).` };
  return { status: 502, reason: "network", error: "Couldn’t reach the provider. Check your connection." };
}
