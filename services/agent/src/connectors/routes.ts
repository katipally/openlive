import { Hono } from "hono";
import { z } from "zod";
import {
  clearConnectorOAuth, connectorProblems, consentToSpawn, createConnector, getConnectorRow, hasConnectorTokens, listConnectorRows,
  McpFileError, removeConnector, setConnectorToolsEnabled, transportWire, updateConnector, type ConnectorRow,
} from "@openlive/db";
import type { ConnectorWire } from "@openlive/shared";
import { log } from "../log.js";
import { connectors, errText } from "./manager.js";
import { finishSignIn, OAUTH_CALLBACK_PATH, startSignIn } from "./oauth.js";
import { exposedNames } from "./tools.js";
import { fromMcpServers, importSources, preview, readSource, sameness, type Found } from "./import.js";

// The /connectors REST surface, behind the same shared-secret gate as the rest
// of the agent. The one exception is the OAuth callback, which a browser lands
// on with no way to send the secret: it is guarded by its single-use state.

export const connectorRoutes = new Hono();

// mcp.json is broken by hand: say so, and leave the file for the person to fix.
connectorRoutes.onError((e, c) => {
  if (e instanceof McpFileError) return c.json({ error: e.message }, 409);
  throw e;
});

/** Rows as the UI sees them. Names are computed across all rows at once, as the registry computes them. */
export function wires(rows: ConnectorRow[]): ConnectorWire[] {
  const names = exposedNames(rows);
  return rows.map((row) => {
    const off = new Set(row.disabledTools);
    const s = connectors.status(row);
    return {
      id: row.id, name: row.name, slug: row.slug, transport: transportWire(row.transport),
      enabled: row.enabled, source: row.source, createdAt: row.createdAt, spawnConsent: row.spawnConsent,
      ...(row.clientMetadataUrl && { clientMetadataUrl: row.clientMetadataUrl }),
      signedIn: hasConnectorTokens(row),
      trustReadOnly: !!row.trustReadOnly,
      status: s.status, ...(s.error && { error: s.error }),
      tools: (row.tools ?? []).map((t) => ({ name: t.name, exposedName: names.get(row.slug)?.get(t.name) ?? t.name, description: t.description, readOnly: t.readOnly, enabled: !off.has(t.name) })),
    };
  });
}

const one = (id: string): ConnectorWire | undefined => wires(listConnectorRows()).find((w) => w.id === id);

/** Connect, so the reply carries the outcome (tools, or why not). A failure is in the status, not an HTTP error. */
export async function settle(id: string): Promise<void> {
  await connectors.reconnect(id).catch((e) => log.warn("connectors", `connect ${id}:`, errText(e)));
}

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  try { const r = schema.safeParse(await c.req.json()); return r.success ? r.data : null; }
  catch { return null; }
}

const strMap = z.record(z.string(), z.string());
export const addSchema = z.union([
  z.object({ url: z.string().url(), name: z.string().optional(), headers: strMap.optional() }),
  z.object({ json: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
]);

/**
 * Add by URL, or from `{ "mcpServers": { ... } }` (or just the map inside it),
 * for this route and the add_connector tool. Secrets go through the store's
 * encrypted path. An http server is reached at once; a stdio one waits for
 * the person's consent, which only its own route gives.
 */
export async function addConnectors(b: z.infer<typeof addSchema>): Promise<{ connectors: ConnectorWire[]; warnings: string[] } | { error: string }> {
  let found: Found[];
  if ("url" in b) {
    found = [{ name: b.name?.trim() || new URL(b.url).hostname, transport: { type: "http", url: b.url, headers: b.headers ?? {} }, warnings: [] }];
  } else {
    let parsed: unknown;
    try { parsed = typeof b.json === "string" ? JSON.parse(b.json) : b.json; }
    catch { return { error: "That is not valid JSON." }; }
    found = fromMcpServers(parsed, "mcpServers", true);
    if (!found.length) return { error: "No MCP servers found in that JSON." };
  }
  const created: ConnectorRow[] = [];
  for (const f of found) created.push(await createConnector({ name: f.name, transport: f.transport, source: "manual" }));
  await Promise.all(created.filter((r) => r.transport.type === "http").map((r) => settle(r.id)));
  const ids = new Set(created.map((r) => r.id));
  return { connectors: wires(listConnectorRows()).filter((w) => ids.has(w.id)), warnings: found.flatMap((f) => f.warnings) };
}

connectorRoutes.get("/", (c) => c.json({ connectors: wires(listConnectorRows()), problems: connectorProblems() }));

connectorRoutes.post("/", async (c) => {
  const b = await body(c, addSchema);
  if (!b) return c.json({ error: "Send a url, or json in the mcpServers shape." }, 400);
  const r = await addConnectors(b);
  return c.json(r, "error" in r ? 400 : 201);
});

const patchSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  trustReadOnly: z.boolean().optional(),
  clientMetadataUrl: z.string().url().nullable().optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: strMap.optional(),
  secretEnv: z.record(z.string(), z.string().nullable()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string().nullable()).optional(),
});

connectorRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const p = await body(c, patchSchema);
  if (!p) return c.json({ error: "invalid update" }, 400);
  if (!(await updateConnector(id, p))) return c.json({ error: "not found" }, 404);
  // The next use connects with what was just saved.
  await connectors.disconnect(id);
  return c.json(one(id));
});

connectorRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await connectors.disconnect(id);
  return (await removeConnector(id)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

connectorRoutes.post("/:id/enabled", async (c) => {
  const id = c.req.param("id");
  const b = await body(c, z.object({ enabled: z.boolean() }));
  if (!b) return c.json({ error: "send { enabled }" }, 400);
  if (!(await updateConnector(id, { enabled: b.enabled }))) return c.json({ error: "not found" }, 404);
  if (!b.enabled) await connectors.disconnect(id);
  return c.json(one(id));
});

connectorRoutes.post("/:id/tools/:tool/enabled", async (c) => {
  const id = c.req.param("id");
  const b = await body(c, z.object({ enabled: z.boolean() }));
  if (!b) return c.json({ error: "send { enabled }" }, 400);
  if (!(await setConnectorToolsEnabled(id, [c.req.param("tool")], b.enabled))) return c.json({ error: "not found" }, 404);
  return c.json(one(id));
});

connectorRoutes.post("/:id/tools/enabled", async (c) => {
  const id = c.req.param("id");
  const b = await body(c, z.object({ tools: z.array(z.string()), enabled: z.boolean() }));
  if (!b) return c.json({ error: "send { tools, enabled }" }, 400);
  if (!(await setConnectorToolsEnabled(id, b.tools, b.enabled))) return c.json({ error: "not found" }, 404);
  return c.json(one(id));
});

// The person agreed this stdio server may run. Only now is it ever started.
connectorRoutes.post("/:id/consent", async (c) => {
  const id = c.req.param("id");
  if (!(await consentToSpawn(id))) return c.json({ error: "not found" }, 404);
  await settle(id);
  return c.json(one(id));
});

connectorRoutes.post("/:id/reconnect", async (c) => {
  const id = c.req.param("id");
  if (!getConnectorRow(id)) return c.json({ error: "not found" }, 404);
  await settle(id);
  return c.json(one(id));
});

// The page to open for signing in. The UI opens it, as it opens every link.
connectorRoutes.post("/:id/oauth/start", async (c) => {
  const id = c.req.param("id");
  const row = getConnectorRow(id);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.transport.type !== "http") return c.json({ error: "Only an http connector signs in." }, 400);
  try {
    const r = await startSignIn(id, row.transport.url);
    if ("authorized" in r) { await settle(id); return c.json({ connector: one(id) }); }
    return c.json(r);
  } catch (e) {
    log.warn("connectors", `sign-in ${id}:`, e);
    return c.json({ error: errText(e) }, 502);
  }
});

connectorRoutes.post("/:id/oauth/signout", async (c) => {
  const id = c.req.param("id");
  if (!(await clearConnectorOAuth(id, "all"))) return c.json({ error: "not found" }, 404);
  await connectors.disconnect(id);
  return c.json(one(id));
});

const page = (title: string, detail: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenLive</title>
<body style="font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:Canvas;color:CanvasText;color-scheme:light dark">
<main style="max-width:32rem;text-align:center"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(detail)}</p></main>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

connectorRoutes.get(OAUTH_CALLBACK_PATH.slice("/connectors".length), async (c) => {
  try {
    const id = await finishSignIn(new URL(c.req.url).searchParams, (cid) => {
      const t = getConnectorRow(cid)?.transport;
      return t?.type === "http" ? t.url : undefined;
    });
    await settle(id);
    return c.html(page("Signed in", `${getConnectorRow(id)?.name ?? "The connector"} is connected. You can close this tab and go back to OpenLive.`));
  } catch (e) {
    log.warn("connectors", "sign-in callback:", e);
    return c.html(page("Sign-in did not finish", errText(e)), 400);
  }
});

// ── import ──────────────────────────────────────────────────────────────────

const read = () => importSources().map((spec) => readSource(spec));

connectorRoutes.get("/import", (c) => c.json({ sources: preview(listConnectorRows(), read()) }));

// Commit names what to bring over; the definitions are read again here, never
// taken from the request, so only what is on disk is imported.
connectorRoutes.post("/import", async (c) => {
  const b = await body(c, z.object({ items: z.array(z.object({ source: z.string(), name: z.string() })).min(1) }));
  if (!b) return c.json({ error: "send { items: [{ source, name }] }" }, 400);
  const sources = read();
  const have = new Set(listConnectorRows().map((r) => sameness(r.transport)));
  const created: ConnectorRow[] = [];
  const skipped: { source: string; name: string; reason: string }[] = [];
  for (const item of b.items) {
    const src = sources.find((s) => s.spec.id === item.source);
    const f = src?.servers.find((s) => s.name === item.name);
    if (!src || !f) { skipped.push({ ...item, reason: "not found" }); continue; }
    const key = sameness(f.transport);
    if (have.has(key)) { skipped.push({ ...item, reason: "already added" }); continue; }
    have.add(key);
    created.push(await createConnector({ name: f.name, transport: f.transport, source: src.spec.id }));
  }
  await Promise.all(created.filter((r) => r.transport.type === "http").map((r) => settle(r.id)));
  const ids = new Set(created.map((r) => r.id));
  return c.json({ connectors: wires(listConnectorRows()).filter((w) => ids.has(w.id)), skipped }, 201);
});

