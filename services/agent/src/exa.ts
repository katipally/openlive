// Web search via Exa's HOSTED MCP server (https://mcp.exa.ai/mcp). It's keyless
// on the free tier (~20k requests/month) — same wiring opencode uses. If the user
// drops an Exa key in Settings (or EXA_API_KEY), we pass it to lift the rate limit.
// One long-lived client, reconnected on failure; callers fall back to a plain
// "couldn't reach the web" message if this throws.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSetting } from "@openlive/db";

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

function exaUrl(): URL {
  const key = (getSetting("exa_api_key") || process.env.EXA_API_KEY || "").trim();
  const u = new URL("https://mcp.exa.ai/mcp");
  u.searchParams.set("tools", "web_search_exa,web_fetch_exa");
  if (key) u.searchParams.set("exaApiKey", key);
  return u;
}

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: "openlive", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(exaUrl()));
    client = c;
    return c;
  })();
  try { return await connecting; }
  finally { connecting = null; }
}

/** Search the web via Exa. Returns readable "Title / URL / Highlights" blocks, or
 *  throws so the tool can tell the user the web was unreachable. */
export async function exaSearch(query: string, numResults = 5): Promise<string> {
  const call = async () => {
    const c = await getClient();
    const r: any = await c.callTool({ name: "web_search_exa", arguments: { query, numResults } });
    return (r?.content ?? []).map((p: any) => p?.text ?? "").filter(Boolean).join("\n").trim();
  };
  try { return await call(); }
  catch {
    // Stale/closed session — drop it and retry once fresh.
    client = null;
    return await call();
  }
}
