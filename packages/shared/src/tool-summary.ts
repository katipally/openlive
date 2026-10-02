// The gist of a tool call's arguments, shown beside the tool's label: "10 min ·
// pasta", "Cmd+S", "notes.md". Shared, so the chat chip, the Flow orb and the
// Flow history all say the same. Typed text is left out on purpose: the label
// already says it typed, and the text may be private.

/** The arguments a chip names, the first one a call has. */
const NAMED = ["url", "path", "query", "command", "name", "app", "note", "title"] as const;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** "PT1H30M" or 90 (seconds) as "1 h 30 min"; anything else as given. */
export function durationWords(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const m = DURATION.exec(text);
  const secs = m ? +(m[1] ?? 0) * 86_400 + +(m[2] ?? 0) * 3_600 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0)
    : /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!(secs > 0)) return text;
  const s = Math.round(secs);
  const parts: [number, string][] = [[Math.floor(s / 86_400), "d"], [Math.floor(s / 3_600) % 24, "h"], [Math.floor(s / 60) % 60, "min"], [s % 60, "s"]];
  return parts.filter(([n]) => n).map(([n, unit]) => `${n} ${unit}`).join(" ");
}

export function toolSummary(name: string, args: Record<string, unknown> | undefined): string | undefined {
  // A read_tool or use_tool call is shown as the tool it runs, still holding
  // the wrapper's arguments: the tool's own sit inside them.
  const { name: named, arguments: inner, ...rest } = args ?? {};
  const a = named !== name ? args ?? {} : inner && typeof inner === "object" ? inner as Record<string, unknown> : rest;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  const said =
    name === "set_timer" ? [a.duration != null ? durationWords(a.duration) : "", str("label")].filter(Boolean).join(" · ")
    : name === "remind" ? str("text")
    : name === "cancel_reminder" ? str("text_match") || str("id")
    : name === "keypress" ? (Array.isArray(a.keys) ? a.keys.map(String).join("+") : "")
    : NAMED.map(str).find(Boolean) ?? "";
  return said || undefined;
}
