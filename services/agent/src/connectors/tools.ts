import { createHash } from "node:crypto";
import { ProtocolError, ProtocolErrorCode, type CallToolResult } from "@modelcontextprotocol/client";
import { listConnectorRows, type CachedTool, type ConnectorRow } from "@openlive/db";
import type { ToolProvider } from "../capabilities/registry.js";
import type { ImagePart, Session, TextPart, Tool, ToolResult } from "../capabilities/types.js";
import { connectors, type ConnectorManager } from "./manager.js";

// Connector tools as registry tools. Registered once, so every brain in both
// modes gets them: an API brain as native tools, an ACP agent through the one
// `openlive` MCP server, which is the only way an agent reaches a connector.

/** What every provider accepts as a tool name: OpenAI's limit, the strictest. */
const NAME_MAX = 64;
/** A result this big is a page of text the model reads in one go, as fetch_url's cap. */
export const RESULT_TEXT_MAX = 20_000;
/** Pictures per result, and the largest one (base64), under what providers take per image. */
export const RESULT_IMAGES_MAX = 4;
export const RESULT_IMAGE_MAX = 5_000_000;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const hash6 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

/**
 * `<slug>__<tool>` for every tool, unique and within provider limits. A name
 * that is too long, or that sanitizes onto one already given out, ends in a
 * hash of the original pair instead, so it is the same name every time.
 * Deterministic for a given set: connectors by slug, tools by name.
 * O(n log n) in the number of tools.
 */
export function exposedNames(rows: readonly Pick<ConnectorRow, "slug" | "tools">[]): Map<string, Map<string, string>> {
  const taken = new Set<string>();
  const out = new Map<string, Map<string, string>>();
  for (const row of [...rows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const names = new Map<string, string>();
    for (const tool of [...(row.tools ?? [])].map((t) => t.name).sort()) {
      let name = `${row.slug}__${sanitize(tool)}`;
      if (name.length > NAME_MAX || taken.has(name)) name = `${name.slice(0, NAME_MAX - 7)}_${hash6(`${row.slug}\0${tool}`)}`;
      taken.add(name);
      names.set(tool, name);
    }
    out.set(row.slug, names);
  }
  return out;
}

const text = (t: string): TextPart => ({ type: "text", text: t });

/** A server's result as OpenLive's: text and pictures, everything else spelled out, all of it capped. */
export function toResult(r: CallToolResult): ToolResult<{ structured?: unknown }> {
  const parts: (TextPart | ImagePart)[] = [];
  let images = 0;
  let dropped = 0;
  for (const c of r.content ?? []) {
    if (c.type === "text") parts.push(text(c.text));
    else if (c.type === "image") {
      if (images < RESULT_IMAGES_MAX && c.data.length <= RESULT_IMAGE_MAX) { parts.push({ type: "image", data: c.data, mime: c.mimeType }); images++; }
      else dropped++;
    } else if (c.type === "resource_link") parts.push(text(`Resource: ${c.name}${c.description ? `, ${c.description}` : ""} <${c.uri}>`));
    else if (c.type === "resource") parts.push(text("text" in c.resource ? c.resource.text : `[${c.resource.mimeType ?? "binary"} resource <${c.resource.uri}>]`));
    else if (c.type === "audio") parts.push(text(`[${c.mimeType} audio, not shown]`));
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(text(JSON.stringify(r.structuredContent)));
  if (dropped) parts.push(text(`[${dropped} more image${dropped > 1 ? "s" : ""} left out]`));

  // One budget across every text part, so many small parts cannot add up past it.
  let budget = RESULT_TEXT_MAX;
  const capped = parts.flatMap((p): (TextPart | ImagePart)[] => {
    if (p.type !== "text") return [p];
    if (budget <= 0) return [];
    const kept = p.text.slice(0, budget);
    budget -= p.text.length;
    return [kept.length < p.text.length ? text(`${kept}\n[cut: the result was longer than ${RESULT_TEXT_MAX} characters]`) : p];
  });
  return { content: capped.length ? capped : [text("(no output)")], details: { structured: r.structuredContent } };
}

/** One connector tool. A tool its server does not mark read-only counts as one that changes things. */
export function connectorTool(row: ConnectorRow, t: CachedTool, name: string, manager: ConnectorManager): Tool {
  return {
    name,
    description: `${t.description || t.name} (${row.name})`.trim(),
    parameters: { type: "object", ...t.inputSchema },
    connector: row.name,
    readOnly: t.readOnly,
    ...(!t.readOnly && { confirm: () => `use ${row.name}: ${t.name}` }),
    async execute(args, ctx) {
      let r: CallToolResult;
      try {
        r = await manager.call(row.id, t.name, args as Record<string, unknown>, ctx);
      } catch (e) {
        // The server needs the person in a browser first (-32042): open it and say so.
        if (e instanceof ProtocolError && e.code === ProtocolErrorCode.UrlElicitationRequired) {
          const first = (e.data as { elicitations?: { url?: string; message?: string }[] } | undefined)?.elicitations?.[0];
          if (first?.url && await openPage(ctx, first.url)) return { content: [text(`${row.name} opened a page in the browser to finish setting up${first.message ? ` (${first.message})` : ""}. Ask the user to finish there, then try again.`)], details: {} };
        }
        throw e;
      }
      if (r.isError) throw new Error(toResult(r).content.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("\n") || `${t.name} failed.`);
      return toResult(r);
    },
  };
}

/** Open a page where the session can: the device, or the client's bridge. False where neither is here. */
export async function openPage(s: Session, url: string): Promise<boolean> {
  try {
    if (s.device) await s.device.control({ kind: "open_url", url });
    else if (s.openUrl) await s.openUrl(url);
    else return false;
    return true;
  } catch { return false; }
}

/**
 * Every enabled tool of every connector that may run, from the tool lists last
 * seen. Reading the cache is what lets a session start without waiting on, or
 * spawning, any server; a connection opens when a tool is first called.
 */
export function connectorTools(manager: ConnectorManager = connectors): ToolProvider {
  return () => {
    const rows = runnable();
    manager.freshen(rows);
    return toolsOf(rows, manager);
  };
}

/** The same tools without waking any server, for Settings to count. */
export const listedConnectorTools = (manager: ConnectorManager = connectors): Tool[] => toolsOf(runnable(), manager);

const runnable = () => listConnectorRows().filter((r) => r.enabled && (r.transport.type === "http" || r.spawnConsent));

function toolsOf(rows: ConnectorRow[], manager: ConnectorManager): Tool[] {
  const names = exposedNames(rows);
  return rows.flatMap((row) => {
    const off = new Set(row.disabledTools);
    return (row.tools ?? []).filter((t) => !off.has(t.name)).map((t) => connectorTool(row, t, names.get(row.slug)!.get(t.name)!, manager));
  });
}
