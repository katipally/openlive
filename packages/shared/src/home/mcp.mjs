// mcp.json: connectors in the {"mcpServers": {...}} shape every MCP client
// reads, so it can be edited by hand and copied to or from other tools.
// OpenLive's own fields ride under one "openlive" key per server, which other
// clients ignore. No secret is ever in it: a secret env value or header is a
// "${secret:NAME}" reference into secrets/connectors.json, which holds the
// ciphertext, by connector id. A server's key is its name.
import { createHash } from "node:crypto";

const REF = /^\$\{secret:([^}]+)\}$/;
const ref = (name) => `\${secret:${name}}`;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isStrMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === "string");
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const nonEmpty = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v));
/** Entry fields this file owns. Anything else a person or another tool wrote is kept as it is. */
const KNOWN = ["type", "url", "headers", "command", "args", "cwd", "env", "openlive"];

/** `GitHub (work)` → `github_work`. Short, because it prefixes every tool name. */
export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "") || "mcp";
}

export function uniqueSlug(name, taken) {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}

/** Consent to run is kept for exactly the command and arguments agreed to, so changing either by hand asks again. */
export const runsFingerprint = (command, args) => createHash("sha256").update(JSON.stringify([command, args])).digest("hex").slice(0, 16);

/** A server written by hand has no id yet: one from its key, stable until it is renamed. */
const keyId = (key) => `mcp-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
const idOf = (key, e) => (isObj(e?.openlive) && typeof e.openlive.id === "string" && e.openlive.id ? e.openlive.id : keyId(key));

/** Why an entry cannot be used, or "" when it can. */
function invalid(e) {
  if (!isObj(e)) return "is not an object";
  if (typeof e.url === "string") {
    try { if (!/^https?:$/.test(new URL(e.url).protocol)) return "url must start with http:// or https://"; } catch { return "url is not a web address"; }
    if (e.headers !== undefined && !isStrMap(e.headers)) return `"headers" must map names to text`;
    return "";
  }
  if (typeof e.command !== "string" || !e.command.trim()) return `needs a "command" to run or a "url" to reach`;
  if (e.args !== undefined && !isStrList(e.args)) return `"args" must be a list of text`;
  if (e.env !== undefined && !isStrMap(e.env)) return `"env" must map names to text`;
  if (e.cwd !== undefined && typeof e.cwd !== "string") return `"cwd" must be text`;
  return "";
}

/**
 * mcp.json's text and the parsed secrets file → connector rows. `seal` encrypts
 * a header value written in plain text by hand, so a row's headers are always
 * ciphertext; the next write moves it into secrets/. A server that cannot be
 * used is left out, named in `problems`, and kept verbatim in `invalid` for the
 * next write. A file that cannot be read at all comes back with `doc: null`,
 * and must not be written over. O(servers).
 */
export function readMcp(text, secrets, seal) {
  if (text === undefined) return { doc: {}, rows: [], problems: [], invalid: {} };
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { doc: null, rows: [], problems: [`mcp.json is not valid JSON: ${e.message}`], invalid: {} }; }
  if (!isObj(doc) || (doc.mcpServers !== undefined && !isObj(doc.mcpServers))) {
    return { doc: null, rows: [], problems: [`mcp.json needs an "mcpServers" object`], invalid: {} };
  }
  const rows = [], problems = [], bad = {}, ids = new Set(), used = new Set();
  const entries = Object.entries(doc.mcpServers ?? {});
  // Every slug any server declares, so one made for a new server never takes another's.
  const taken = new Set(entries.map(([, e]) => e?.openlive?.slug).filter((s) => typeof s === "string"));
  for (const [key, e] of entries) {
    const why = invalid(e);
    if (why) { problems.push(`"${key}" ${why}.`); bad[key] = e; continue; }
    const o = isObj(e.openlive) ? e.openlive : {};
    // A pasted copy of another server keeps its "openlive" block: it is a new server all the same.
    const id = ids.has(idOf(key, e)) ? keyId(key) : idOf(key, e);
    ids.add(id);
    const s = isObj(secrets?.[id]) ? secrets[id] : {};
    let transport;
    if (typeof e.url === "string") {
      const headers = {};
      for (const [k, v] of Object.entries(e.headers ?? {})) headers[k] = REF.test(v) ? s.headers?.[REF.exec(v)[1]] ?? "" : seal(v);
      transport = { type: "http", url: e.url.trim(), headers };
    } else {
      const env = {}, secretEnv = {};
      for (const [k, v] of Object.entries(e.env ?? {})) {
        if (REF.test(v)) secretEnv[k] = s.env?.[REF.exec(v)[1]] ?? "";
        else env[k] = v;
      }
      transport = { type: "stdio", command: e.command.trim(), args: e.args ?? [], ...(e.cwd && { cwd: e.cwd }), env, secretEnv };
    }
    let slug = typeof o.slug === "string" && o.slug && !used.has(o.slug) ? o.slug : "";
    if (!slug) taken.add((slug = uniqueSlug(key, taken)));
    used.add(slug);
    rows.push({
      id,
      name: key,
      slug,
      source: typeof o.source === "string" ? o.source : "manual",
      createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
      enabled: o.enabled !== false,
      disabledTools: isStrList(o.disabledTools) ? o.disabledTools : [],
      ...(o.trustReadOnly === true && { trustReadOnly: true }),
      // An http server only ever receives requests; running a command is the risk.
      spawnConsent: transport.type === "http" || o.spawnConsent === runsFingerprint(transport.command, transport.args),
      transport,
      ...(typeof o.clientMetadataUrl === "string" && { clientMetadataUrl: o.clientMetadataUrl }),
      ...(Array.isArray(o.tools) && { tools: o.tools, toolsAt: typeof o.toolsAt === "number" ? o.toolsAt : 0 }),
      ...(typeof o.toolsTtlMs === "number" && { toolsTtlMs: o.toolsTtlMs }),
      ...(isObj(s.oauth) && { oauth: s.oauth }),
    });
  }
  return { doc, rows, problems, invalid: bad };
}

/**
 * Rows → the mcp.json document and the secrets file. `doc` is what the rows were
 * read from: its other keys, and each server's fields this file does not own,
 * are kept; `invalid` servers are written back untouched, with their secrets
 * from `oldSecrets`. Names stay unique, since a name is the key. O(servers).
 */
export function writeMcp(rows, doc = {}, invalidServers = {}, oldSecrets = {}) {
  const prev = new Map(Object.entries(doc.mcpServers ?? {}).map(([key, e]) => [idOf(key, e), e]));
  const taken = new Set(Object.keys(invalidServers));
  const servers = {}, secrets = {};
  for (const [key, e] of Object.entries(invalidServers)) if (oldSecrets[idOf(key, e)]) secrets[idOf(key, e)] = oldSecrets[idOf(key, e)];
  for (const row of rows) {
    const t = row.transport;
    const extra = Object.fromEntries(Object.entries(prev.get(row.id) ?? {}).filter(([k]) => !KNOWN.includes(k)));
    const refs = (m) => Object.fromEntries(Object.keys(m).map((k) => [k, ref(k)]));
    const env = t.type === "stdio" ? { ...t.env, ...refs(t.secretEnv) } : {};
    const sealed = t.type === "stdio" ? { env: nonEmpty(t.secretEnv) } : { headers: nonEmpty(t.headers) };
    const keep = Object.fromEntries(Object.entries({ ...sealed, oauth: row.oauth }).filter(([, v]) => v && Object.keys(v).length));
    if (Object.keys(keep).length) secrets[row.id] = keep;
    const name = uniqueName(row.name, taken);
    taken.add(name);
    const prevType = prev.get(row.id)?.type;
    servers[name] = {
      ...extra,
      ...(t.type === "http"
        ? { type: typeof prevType === "string" ? prevType : "http", url: t.url, ...(Object.keys(t.headers).length && { headers: refs(t.headers) }) }
        : { command: t.command, ...(t.args.length && { args: t.args }), ...(t.cwd && { cwd: t.cwd }), ...(Object.keys(env).length && { env }) }),
      openlive: {
        id: row.id,
        slug: row.slug,
        enabled: row.enabled,
        disabledTools: row.disabledTools,
        ...(row.trustReadOnly && { trustReadOnly: true }),
        source: row.source,
        createdAt: row.createdAt,
        ...(t.type === "stdio" && row.spawnConsent && { spawnConsent: runsFingerprint(t.command, t.args) }),
        ...(row.clientMetadataUrl && { clientMetadataUrl: row.clientMetadataUrl }),
        ...(row.tools && { tools: row.tools, toolsAt: row.toolsAt }),
        ...(row.toolsTtlMs !== undefined && { toolsTtlMs: row.toolsTtlMs }),
      },
    };
  }
  for (const [key, e] of Object.entries(invalidServers)) servers[key] = e;
  return { file: { ...doc, mcpServers: servers }, secrets };
}
