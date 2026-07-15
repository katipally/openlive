import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadEnv } from "@openlive/db";
import { ensureSeedProviders } from "./providers.js";
import { attachLiveWs } from "./live/ws.js";
import type { Server } from "node:http";

loadEnv();
ensureSeedProviders();

// Shared-secret gate + locked CORS. The agent sits behind the Next proxy on
// localhost; the secret is opt-in (skipped for pure local dev).
const AGENT_SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";
const WEB_ORIGIN = process.env.WEB_PUBLIC_URL?.trim() || "http://localhost:3000";

const app = new Hono();
app.use("*", cors({ origin: WEB_ORIGIN }));
app.use("*", async (c, next) => {
  if (!AGENT_SECRET || c.req.path === "/health") return next();
  if (c.req.header("x-openlive-secret") !== AGENT_SECRET) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.get("/health", (c) => c.json({ ok: true }));

const port = Number(process.env.AGENT_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }) as unknown as Server;
const wss = attachLiveWs(server); // live voice+vision on ws://…/live
console.log(`▸ OpenLive agent service listening on http://localhost:${port}`);

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") console.error(`[agent] port ${port} is already in use — kill the old process or set AGENT_PORT.`);
  else console.error("[agent] server error:", e);
  process.exit(1);
});
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  for (const c of wss.clients) { try { c.close(); } catch { /* */ } }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A stray rejection/exception in one live session (e.g. an ACP call the agent
// rejects) must NEVER take down the whole service — that would drop every live
// socket, surfacing as "Couldn't connect to live mode". Log and keep serving.
process.on("unhandledRejection", (e) => console.error("[agent] unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("[agent] uncaughtException:", e));
