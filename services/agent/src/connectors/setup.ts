import { connectorSecrets, getConnectorRow, listConnectorRows, type ConnectorRow } from "@openlive/db";
import type { ConnectorWire } from "@openlive/shared";
import type { TextPart, Tool } from "../capabilities/types.js";
import { errText } from "./manager.js";
import { startSignIn } from "./oauth.js";
import { addConnectors, addSchema, settle, wires } from "./routes.js";
import { openPage } from "./tools.js";

// Setting connectors up by voice: the connector-setup skill's tools. They reuse
// what the Connectors settings call, and what they hand the model never holds
// a secret: no header or env value, no arguments, no URL query, and any secret
// a server echoes into an error is blanked.

const text = (t: string): TextPart => ({ type: "text", text: t });
function fail(why: string): never { throw new Error(why); }

/** Secrets too short to blank without mangling ordinary words are not worth matching. */
const SECRET_MIN = 4;

/** `text` with every secret value of the row blanked. O(secrets x text). */
function scrub(t: string, row: ConnectorRow | undefined): string {
  if (!row) return t;
  return Object.values(connectorSecrets(row)).filter((v) => v.length >= SECRET_MIN).reduce((out, v) => out.split(v).join("[hidden]"), t);
}

/** Where it lives, without a query string, which can carry a key. */
function place(w: ConnectorWire): string {
  if (w.transport.type === "stdio") return `runs ${w.transport.command} on this computer`;
  try { const u = new URL(w.transport.url); return `${u.origin}${u.pathname}`; } catch { return "a web address"; }
}

const STATUS: Record<ConnectorWire["status"], string> = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "not connected yet; it connects when a tool is first used",
  disabled: "switched off in Settings",
  needs_consent: "waiting for the user to allow it to run, in Settings, Capabilities, Connectors. You cannot allow it for them",
  needs_auth: "needs the user to sign in: call connector_sign_in",
  error: "failed",
};

/** One connector, in a line the model can say back. Never a secret. */
function describe(w: ConnectorWire): string {
  const row = getConnectorRow(w.id);
  const on = w.tools.filter((t) => t.enabled).length;
  const tools = w.tools.length ? `${on} of ${w.tools.length} tools on` : "no tools listed yet";
  const status = `${STATUS[w.status]}${w.error ? `: ${scrub(w.error, row)}` : ""}`;
  return `- ${w.name} (id ${w.id}): ${place(w)}. Status: ${status}. ${tools}.${w.signedIn ? " Signed in." : ""}`;
}

const byId = (id: string) => wires(listConnectorRows()).find((w) => w.id === id) ?? fail(`There is no connector with id ${id}. Call list_connectors for the ids.`);

const ID = { id: { type: "string", description: "The connector's id, from list_connectors." } };

const listConnectors: Tool<Record<string, never>, null> = {
  name: "list_connectors",
  group: "connectors",
  readOnly: true,
  description: "The MCP connectors the user has added, each with its id, where it runs, its status and how many tools it offers. Never shows a secret.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const all = wires(listConnectorRows());
    return { content: [text(all.length ? all.map(describe).join("\n") : "No connectors yet.")], details: null };
  },
};

type AddArgs = { url?: string; name?: string; headers?: Record<string, string>; json?: string };

const addConnector: Tool<AddArgs, { ids: string[] }> = {
  name: "add_connector",
  group: "connectors",
  description: "Add an MCP connector: a server's URL, or the JSON a server's docs give in the mcpServers shape. Keys and tokens are stored encrypted and never shown back. A server that runs on this computer still needs the user to allow it in Settings, Capabilities, Connectors; this tool cannot.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "An http or https MCP server address. Use this or json." },
      name: { type: "string", description: "What to call it, with url. Defaults to the host name." },
      headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers for url, as an API key header. Stored encrypted." },
      json: { type: "string", description: "A pasted mcpServers object, or the map inside it. Use this or url." },
    },
    additionalProperties: false,
  },
  confirm: (a) => `add the connector ${a.name?.trim() || a.url?.split("?")[0] || "from the pasted JSON"}`,
  precheck(a) { if (!addSchema.safeParse(a).success) fail("Give url (an http or https address) or json, not both and not neither."); },
  async execute(a) {
    const r = await addConnectors(addSchema.parse(a));
    if ("error" in r) fail(r.error);
    const { connectors: added, warnings } = r;
    const local = added.some((w) => w.status === "needs_consent");
    const lines = [
      `Added ${added.length === 1 ? "this connector" : `${added.length} connectors`}:`,
      ...added.map(describe),
      ...warnings.map((w) => `Note: ${w}`),
      ...(local ? ["A connector that runs on this computer stays off until the user allows it in Settings, Capabilities, Connectors. Adding it here did not allow it, and no tool can. Ask them to look there."] : []),
    ];
    return { content: [text(lines.join("\n"))], details: { ids: added.map((w) => w.id) } };
  },
};

// Not asked first: starting a sign-in only opens the server's own page, and the
// person signing in there is the consent. Nothing is stored until they finish.
const connectorSignIn: Tool<{ id: string }, { url?: string }> = {
  name: "connector_sign_in",
  group: "connectors",
  description: "Start signing in to a connector that needs it. Opens the sign-in page in the user's browser where it can, and returns its address. The user finishes there; then check with list_connectors.",
  parameters: { type: "object", properties: ID, required: ["id"], additionalProperties: false },
  async execute({ id }, ctx) {
    const w = byId(id);
    const row = getConnectorRow(id)!;
    if (row.transport.type !== "http") fail(`${w.name} runs on this computer and has no sign-in. Its keys are set in Settings, Capabilities, Connectors.`);
    const r = await startSignIn(id, row.transport.url).catch((e) => fail(`${w.name} did not offer a sign-in: ${scrub(errText(e), row)}`));
    if ("authorized" in r) {
      await settle(id);
      return { content: [text(`${w.name} is already signed in.\n${describe(byId(id))}`)], details: {} };
    }
    const url = r.authorizationUrl;
    const opened = await openPage(ctx, url);
    return {
      content: [text(opened
        ? `Opened the ${w.name} sign-in page in the browser. Ask the user to finish there, then check with list_connectors.`
        : `Ask the user to open this page to sign in to ${w.name}, then check with list_connectors: ${url}`)],
      details: { url },
    };
  },
};

const reconnectConnector: Tool<{ id: string }, null> = {
  name: "reconnect_connector",
  group: "connectors",
  description: "Close and reopen a connector's connection, for one that failed or lists stale tools. Never starts one the user has not allowed to run.",
  parameters: { type: "object", properties: ID, required: ["id"], additionalProperties: false },
  async execute({ id }) {
    byId(id);
    await settle(id);
    return { content: [text(describe(byId(id)))], details: null };
  },
};

/** Registered as built-ins, so every brain in both modes has them. */
export const CONNECTOR_SETUP_TOOLS: Tool[] = [listConnectors, addConnector, connectorSignIn, reconnectConnector];
