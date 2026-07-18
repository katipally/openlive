// Pure interpreters for a SPOKEN answer to an agent modal (permission / elicitation).
// Extracted from useLiveSession so they can be unit-tested without the React hook.

// Classify a spoken reply to a permission ask; ambiguous → null (keep waiting).
export function classifyYesNo(text: string): "allow" | "deny" | null {
  const t = text.toLowerCase();
  if (/\b(yes|yeah|yep|sure|ok|okay|approve|allow|go ahead|do it|confirm|permit|sounds good|please do)\b/.test(t)) return "allow";
  if (/\b(no|nope|deny|don'?t|do not|stop|cancel|reject|decline|never mind)\b/.test(t)) return "deny";
  return null;
}

// Map a spoken answer onto an elicitation form schema, hands-free: if a field lists
// options, match the utterance to one (say the choice); otherwise drop the words into
// the first free-text field. Returns the content to submit, or null if nothing fit.
export function buildElicitationAnswer(schema: unknown, text: string): Record<string, unknown> | null {
  type Prop = { type?: string; enum?: unknown[]; oneOf?: Array<{ const?: unknown; title?: unknown }>; items?: { enum?: unknown[] } };
  const props = Object.entries(((schema ?? {}) as { properties?: Record<string, Prop> }).properties ?? {});
  if (!props.length || !text) return null;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nt = norm(text);
  const content: Record<string, unknown> = {};
  let freeKey: string | null = null;
  for (const [key, p] of props) {
    const opts: string[] =
      Array.isArray(p.enum) ? p.enum.map(String)
      : Array.isArray(p.oneOf) ? p.oneOf.map((o) => String(o.const ?? o.title ?? ""))
      : Array.isArray(p.items?.enum) ? p.items!.enum!.map(String)
      : [];
    if (opts.length) {
      const hit = opts.find((o) => o && (nt === norm(o) || nt.includes(norm(o)) || norm(o).includes(nt)));
      if (hit) content[key] = p.type === "array" ? [hit] : hit;
    } else if (!freeKey && (p.type === undefined || p.type === "string")) {
      freeKey = key;
    }
  }
  if (!Object.keys(content).length && freeKey) content[freeKey] = text;
  return Object.keys(content).length ? content : null;
}
