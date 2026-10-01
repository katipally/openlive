import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { z, type ZodRawShape } from "zod";
import { exaSearch } from "../exa.js";
import type { Tool, ToolResult } from "./types.js";

const text = (t: string): ToolResult<null> => ({ content: [{ type: "text", text: t }], details: null });

// Decode a numeric character reference. fromCodePoint (not fromCharCode) so astral
// codepoints — emoji, rare CJK — decode to whole characters instead of broken
// surrogate halves. Out-of-range values decode to nothing.
function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

// Minimal HTML → text for fetch_url: drop script/style, strip tags, unescape
// common entities, collapse whitespace.
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&") // last: so "&amp;lt;" → "&lt;", not "<"
    .replace(/\s+/g, " ")
    .trim();
}

// Zod shape → JSON Schema for the model. Inline refs and drop $schema so every
// provider adapter accepts it.
export function params(shape: ZodRawShape): Record<string, unknown> {
  const js = z.toJSONSchema(z.object(shape), { target: "draft-07" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

// fetch_url SSRF guard: block loopback / private / link-local / metadata hosts.
function isPrivateIp4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 || p[0] === 10 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||                 // link-local + cloud metadata (169.254.169.254)
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127);    // carrier-grade NAT
}
export function isPrivateIp(ip: string): boolean {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s === "::1" || s === "::" || s.startsWith("fe80:") || s.startsWith("fc") || s.startsWith("fd")) return true;
  // IPv4-mapped / -embedded IPv6 (e.g. ::ffff:127.0.0.1, ::ffff:7f00:1, ::127.0.0.1)
  // must be unwrapped and checked as IPv4 — otherwise http://[::ffff:127.0.0.1]/
  // slipped straight past the guard.
  const dotted = s.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) return isPrivateIp4(dotted[1]!);
  const hex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return isPrivateIp4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  return isPrivateIp4(s); // plain IPv4 (a public IPv6 returns false here → allowed)
}

/** Resolve a hostname to the addresses we'll actually connect to, or null if ANY
 *  of them is private/loopback/metadata. Returns the vetted addresses so the fetch
 *  can be PINNED to them — closing the DNS-rebinding (TOCTOU) window where the name
 *  re-resolves to a private IP between this check and the socket connect. */
async function resolvePublicAddrs(hostname: string): Promise<string[] | null> {
  if (isIP(hostname)) return isPrivateIp(hostname) ? null : [hostname];
  if (/^(localhost|.*\.local)$/i.test(hostname)) return null;
  let addrs: { address: string }[];
  try { addrs = await dnsLookup(hostname, { all: true }); }
  catch { return null; } // unresolvable → refuse
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
  return addrs.map((a) => a.address);
}

// ── the research worker's tools ─────────────────────────────────────────────
// These run inside the delegated worker, never in a voice turn: the brain the
// user talks to hands web work off with `delegate` and keeps talking.

const webSearch: Tool<{ query: string }, null> = {
  name: "web_search",
  description: "Search the web for current or factual info — news, weather, prices, recent events, a specific fact. Returns titles, URLs, and highlights (fetch_url a result for its full text).",
  parameters: params({ query: z.string().describe("What to search for") }),
  readOnly: true,
  async execute(args, { emit = () => {} }) {
    const id = randomUUID();
    const q = String(args.query ?? "").trim();
    await emit({ type: "tool_start", id, tool: "web_search", summary: q });
    if (!q) { await emit({ type: "tool_done", id, detail: "empty" }); return text("No search query given."); }
    try {
      const out = await exaSearch(q);
      await emit({ type: "tool_done", id, detail: out ? "ok" : "no results" });
      return text(out || `No results for "${q}".`);
    } catch (e: any) {
      await emit({ type: "tool_done", id, detail: "error" });
      return text(`Couldn't reach the web just now (${String(e?.message ?? e).slice(0, 80)}). Tell the user search is temporarily unavailable.`);
    }
  },
};

const fetchUrl: Tool<{ url: string }, null> = {
  name: "fetch_url",
  description: "Fetch a public web page and return its readable text. Use for a specific URL. Returns plain text (scripts/markup stripped).",
  parameters: params({ url: z.string().describe("The absolute http(s) URL to fetch") }),
  readOnly: true,
  async execute(args, { emit = () => {} }) {
    const id = randomUUID();
    const raw = String(args.url ?? "").trim();
    await emit({ type: "tool_start", id, tool: "fetch_url", summary: raw });
    let url: URL;
    try { url = new URL(raw); } catch { await emit({ type: "tool_done", id, detail: "bad url" }); return text(`"${raw}" is not a valid URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") { await emit({ type: "tool_done", id, detail: "blocked" }); return text("Only http(s) URLs are allowed."); }
    const vetted = await resolvePublicAddrs(url.hostname);
    if (!vetted) { await emit({ type: "tool_done", id, detail: "blocked" }); return text("That host is not allowed (private/loopback/metadata address)."); }
    // Pin the socket to a pre-vetted address: undici otherwise re-resolves the
    // hostname on connect, which a DNS-rebinding attacker can flip to a private IP
    // in the window between the check above and the connect. The Host/SNI still use
    // url.hostname, so name-based virtual hosts and TLS keep working.
    const dispatcher = new Agent({
      connect: { lookup: (_h: unknown, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: vetted[0]!, family: isIP(vetted[0]!) || 4 }]) },
    });
    try {
      // `dispatcher` is an undici extension to fetch options, not in the DOM lib types.
      const fetchOpts: Record<string, unknown> = { dispatcher, signal: AbortSignal.timeout(15_000), redirect: "manual", headers: { "user-agent": "OpenLiveBot/1.0" } };
      const res = await fetch(url, fetchOpts as RequestInit);
      if (res.status >= 300 && res.status < 400) { await emit({ type: "tool_done", id, detail: "redirect" }); return text("The URL redirected; pass the final URL directly."); }
      if (!res.ok) { await emit({ type: "tool_done", id, detail: `HTTP ${res.status}` }); return text(`Fetch failed: HTTP ${res.status}.`); }
      const body = htmlToText(await res.text()).slice(0, 20_000);
      await emit({ type: "tool_done", id, detail: `${body.length} chars` });
      return text(body || "(no readable text found)");
    } catch (e: any) { await emit({ type: "tool_done", id, detail: "error" }); return text(`Could not fetch: ${String(e?.message ?? e)}`); }
  },
};

/** The worker's own tools. */
export const WORKER_TOOLS: Tool[] = [webSearch, fetchUrl];
