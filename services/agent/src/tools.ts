import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SseEvent } from "@openlive/shared";
import { getSetting, setSetting } from "@openlive/db";

export type Emit = (e: SseEvent) => Promise<void> | void;

export interface TaktTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any) => Promise<ToolResult>;
}
export interface ToolResult {
  output: string;
  images?: { data: string; mime: string }[];
  isError?: boolean;
}

const text = (t: string): ToolResult => ({ output: t });

// Minimal HTML → text for fetch_url: drop script/style, strip tags, unescape
// common entities, collapse whitespace.
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

// Web search. The DuckDuckGo html endpoint gives real web results but must be
// POSTed (GET → 202 challenge) and rate-limits from some IPs; the official
// Instant-Answer JSON API is reliable but only covers entities/definitions. Run
// both in parallel and prefer the richer html results, so a blocked scrape still
// falls back to a real answer.
async function ddgHtmlResults(q: string): Promise<string[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://duckduckgo.com/",
    },
    body: new URLSearchParams({ q }).toString(),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const results: string[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 6) {
    if (/duckduckgo\.com\/y\.js|ad_domain=|ad_provider=/.test(m[1]!)) continue; // skip sponsored/ad links
    const href = decodeURIComponent(m[1]!.match(/uddg=([^&]+)/)?.[1] ?? m[1]!);
    const title = htmlToText(m[2]!);
    if (title) results.push(`${title}\n  ${href}`);
  }
  return results;
}
async function ddgInstantAnswer(q: string): Promise<string[]> {
  const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&t=openlive`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const j: any = await res.json();
  const out: string[] = [];
  const abs = String(j.AbstractText || j.Abstract || "").trim();
  if (abs) out.push(`${j.Heading ? `${j.Heading} — ` : ""}${abs}${j.AbstractURL ? `\n  ${j.AbstractURL}` : ""}`);
  if (j.Answer) out.push(String(j.Answer).replace(/\s+/g, " ").trim());
  for (const t of Array.isArray(j.RelatedTopics) ? j.RelatedTopics : []) {
    if (out.length >= 5) break;
    if (t?.Text) out.push(`${t.Text}${t.FirstURL ? `\n  ${t.FirstURL}` : ""}`);
  }
  return out;
}

// Zod shape → JSON Schema for the model. Inline refs and drop $schema so every
// provider adapter accepts it.
function params(shape: ZodRawShape): Record<string, unknown> {
  const js = zodToJsonSchema(z.object(shape), { $refStrategy: "none" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

// fetch_url SSRF guard: block loopback / private / link-local / metadata hosts.
function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 127 || p[0] === 10 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||           // link-local + cloud metadata
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168);
}
async function hostIsPrivate(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return isPrivateIp(hostname);
  if (/^(localhost|.*\.local)$/i.test(hostname)) return true;
  try { const { address } = await dnsLookup(hostname); return isPrivateIp(address); }
  catch { return true; } // unresolvable → refuse
}

// The generic tool set the live agent always has. `look` (camera) is injected
// per-session by LiveSession; register your own tools by passing them to the
// turn runner's `extraTools`.
export function buildTaktTools(ctx: { emit: Emit }): TaktTool[] {
  const { emit } = ctx;

  const updateTodos: TaktTool = {
    name: "update_todos",
    description: "Publish/update a short checklist (3+ steps) shown in the UI; mark items done as you go. Skip for simple answers.",
    parameters: params({ items: z.array(z.object({ text: z.string(), done: z.boolean() })).min(1).max(8) }),
    execute: async (args) => {
      const items = Array.isArray(args?.items) ? args.items.map((i: any) => ({ text: String(i.text ?? ""), done: !!i.done })).filter((i: any) => i.text) : [];
      await emit({ type: "todos", items });
      return text("Checklist updated.");
    },
  };

  const fetchUrl: TaktTool = {
    name: "fetch_url",
    description: "Fetch a public web page and return its readable text. Use when the user asks about a specific URL. Returns plain text (scripts/markup stripped).",
    parameters: params({ url: z.string().describe("The absolute http(s) URL to fetch") }),
    execute: async (args) => {
      const id = randomUUID();
      const raw = String(args.url ?? "").trim();
      await emit({ type: "tool_start", id, tool: "fetch_url", summary: raw });
      let url: URL;
      try { url = new URL(raw); } catch { await emit({ type: "tool_done", id, detail: "bad url" }); return text(`"${raw}" is not a valid URL.`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") { await emit({ type: "tool_done", id, detail: "blocked" }); return text("Only http(s) URLs are allowed."); }
      if (await hostIsPrivate(url.hostname)) { await emit({ type: "tool_done", id, detail: "blocked" }); return text("That host is not allowed (private/loopback/metadata address)."); }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual", headers: { "user-agent": "OpenLiveBot/1.0" } });
        if (res.status >= 300 && res.status < 400) { await emit({ type: "tool_done", id, detail: "redirect" }); return text("The URL redirected; pass the final URL directly."); }
        if (!res.ok) { await emit({ type: "tool_done", id, detail: `HTTP ${res.status}` }); return text(`Fetch failed: HTTP ${res.status}.`); }
        const body = htmlToText(await res.text()).slice(0, 20_000);
        await emit({ type: "tool_done", id, detail: `${body.length} chars` });
        return text(body || "(no readable text found)");
      } catch (e: any) { await emit({ type: "tool_done", id, detail: "error" }); return text(`Could not fetch: ${String(e?.message ?? e)}`); }
    },
  };

  const webSearch: TaktTool = {
    name: "web_search",
    description: "Search the web for current or factual info you don't already know — news, weather, prices, recent events, a specific fact. Returns titles + URLs (fetch_url a result for its full text). Don't use it for things you already know.",
    parameters: params({ query: z.string().describe("What to search for") }),
    execute: async (args) => {
      const id = randomUUID();
      const q = String(args.query ?? "").trim();
      await emit({ type: "tool_start", id, tool: "web_search", summary: q });
      if (!q) { await emit({ type: "tool_done", id, detail: "empty" }); return text("No search query given."); }
      const [html, instant] = await Promise.all([
        ddgHtmlResults(q).catch(() => [] as string[]),
        ddgInstantAnswer(q).catch(() => [] as string[]),
      ]);
      const results = html.length ? html : instant;
      await emit({ type: "tool_done", id, detail: `${results.length} results` });
      return text(results.length ? results.join("\n\n") : `No results found for "${q}" (search may be temporarily rate-limited — tell the user you couldn't reach the web just now).`);
    },
  };

  // Lightweight persistent memory: append a fact to notes.json. Remembered notes
  // are auto-injected into the system prompt on the next call (see buildLivePrompt),
  // so there's no separate "recall" tool — the agent just knows them.
  const remember: TaktTool = {
    name: "remember",
    description: "Save a short fact worth keeping across turns and future calls — the user's name, a preference, an ongoing goal. Use sparingly, one clear fact at a time. You'll automatically know remembered facts next time.",
    parameters: params({ note: z.string().describe("The fact to remember, as one short sentence") }),
    execute: async (args) => {
      const note = String(args.note ?? "").trim().slice(0, 240);
      if (!note) return text("Nothing to remember.");
      const id = randomUUID();
      await emit({ type: "tool_start", id, tool: "remember", summary: note });
      try {
        const cur = JSON.parse(getSetting("agent_notes") ?? "[]") as string[];
        if (!cur.includes(note)) { cur.push(note); setSetting("agent_notes", JSON.stringify(cur.slice(-50))); }
      } catch { /* best-effort */ }
      await emit({ type: "tool_done", id, detail: "saved" });
      return text("Got it — I'll remember that.");
    },
  };

  return [webSearch, fetchUrl, updateTodos, remember];
}
