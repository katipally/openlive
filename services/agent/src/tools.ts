import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SseEvent } from "@openlive/shared";
import { getSetting, setSetting } from "@openlive/db";
import { exaSearch } from "./exa.js";

/** A worker subagent that runs a tool loop on the main agent's behalf. */
export type RunWorker = (task: string, emit: Emit, signal: AbortSignal) => Promise<string>;

export type Emit = (e: SseEvent) => Promise<void> | void;

export interface OpenLiveTool {
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

// ── Individual tools (factories over the turn's `emit`) ──────────────────────
// The WORKER tools (web_search, fetch_url) run inside the delegated subagent; the
// MAIN agent never touches them directly — it hands work off via `delegate` and
// keeps talking. `look` (camera) is injected per-session by LiveSession.

function makeWebSearch(emit: Emit): OpenLiveTool {
  return {
    name: "web_search",
    description: "Search the web for current or factual info — news, weather, prices, recent events, a specific fact. Returns titles, URLs, and highlights (fetch_url a result for its full text).",
    parameters: params({ query: z.string().describe("What to search for") }),
    execute: async (args) => {
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
}

function makeFetchUrl(emit: Emit): OpenLiveTool {
  return {
    name: "fetch_url",
    description: "Fetch a public web page and return its readable text. Use for a specific URL. Returns plain text (scripts/markup stripped).",
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
}

function makeUpdateTodos(emit: Emit): OpenLiveTool {
  return {
    name: "update_todos",
    description: "Publish/update a short checklist (3+ steps) shown in the UI; mark items done as you go. Skip for simple answers.",
    parameters: params({ items: z.array(z.object({ text: z.string(), done: z.boolean() })).min(1).max(8) }),
    execute: async (args) => {
      const items = Array.isArray(args?.items) ? args.items.map((i: any) => ({ text: String(i.text ?? ""), done: !!i.done })).filter((i: any) => i.text) : [];
      await emit({ type: "todos", items });
      return text("Checklist updated.");
    },
  };
}

// Lightweight persistent memory: append a fact to notes.json. Remembered notes
// are auto-injected into the system prompt on the next call (see buildLivePrompt).
function makeRemember(emit: Emit): OpenLiveTool {
  return {
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
}

// The delegation tool: the main voice agent hands a task to a worker subagent that
// owns the web tools. The worker's own tool activity streams to the UI (so the user
// watches it work) while the main agent keeps talking; it returns tight findings the
// main agent then speaks. Present even without `runWorker` (for prompt-cache warming).
function makeDelegate(emit: Emit, signal: AbortSignal | undefined, runWorker?: RunWorker): OpenLiveTool {
  return {
    name: "delegate",
    description: "Hand off anything that needs the web — a search, a lookup, reading a page, checking a current fact — to your assistant, who has those tools. Give the task in one clear line. Say a short natural line to the user FIRST ('let me look that up'), then delegate: your assistant works while you talk, and reports back what it found for you to relay. Don't delegate things you already know — answer those instantly.",
    parameters: params({ task: z.string().describe("The lookup/research task, in one line") }),
    execute: async (args) => {
      const task = String(args.task ?? "").trim();
      if (!task) return text("No task given.");
      if (!runWorker || !signal) return text("(assistant unavailable right now)");
      const out = await runWorker(task, emit, signal);
      return text(out || "(no findings)");
    },
  };
}

/** Tools for the WORKER subagent — the web tools it actually runs. */
export function buildWorkerTools(ctx: { emit: Emit }): OpenLiveTool[] {
  return [makeWebSearch(ctx.emit), makeFetchUrl(ctx.emit)];
}

/** Tools for the MAIN voice agent: it delegates web work and otherwise talks. */
export function buildOpenLiveTools(ctx: { emit: Emit; signal?: AbortSignal; runWorker?: RunWorker }): OpenLiveTool[] {
  return [makeDelegate(ctx.emit, ctx.signal, ctx.runWorker), makeUpdateTodos(ctx.emit), makeRemember(ctx.emit)];
}
