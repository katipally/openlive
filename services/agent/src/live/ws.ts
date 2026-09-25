import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { LiveSession } from "./session.js";
import { FlowLiveSession } from "./flow-ws.js";
import { upgradeAsrStream } from "../voice/native.js";

// Constant-time equality that also hides length differences.
function secretMatches(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given?.trim() ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** No Origin is a non-browser client (the web proxy, a test); a browser always sends one. */
export function loopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname); }
  catch { return false; }
}

// Attach the /live WebSocket to the agent's existing http.Server (the one
// @hono/node-server's serve() returns), leaving every HTTP route untouched.
export function attachLiveWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const AGENT_SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

  const reject = (socket: import("node:stream").Duplex, status: string, why: string) => {
    console.log(`[agent] /live upgrade rejected — ${why}`);
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy();
  };

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "", "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/live" && url.pathname !== "/voice/stream") { socket.destroy(); return; }
    // Two trusted callers: the web proxy (holds the secret, sends the header)
    // and the desktop renderer (browser WebSocket can't set headers → ?token=).
    if (AGENT_SECRET
      && !secretMatches(req.headers["x-openlive-secret"] as string | undefined, AGENT_SECRET)
      && !secretMatches(url.searchParams.get("token") ?? undefined, AGENT_SECRET)) {
      return reject(socket, "401 Unauthorized", "bad or missing secret/token");
    }
    // With no secret (local dev) the port is the only gate, and any web page open
    // in a browser can reach loopback. A page from anywhere else would get a
    // session that spends the user's keys and drives their coding agent.
    if (!AGENT_SECRET && !loopbackOrigin(req.headers.origin)) {
      return reject(socket, "403 Forbidden", `origin ${req.headers.origin} is not this machine`);
    }
    if (url.pathname === "/voice/stream") { upgradeAsrStream(req, socket, head, url.searchParams.get("engine"), url.searchParams.get("lang")); return; }
    const chatId = url.searchParams.get("chat") ?? "";
    // Flow's orb runtime lives in its own renderer, so it opens its own
    // connection to this same endpoint. Same schemas, same permission protocol,
    // nothing about a chat session changes.
    const flow = url.searchParams.get("flow") === "1";
    console.log(`[agent] /live upgrade accepted — ${flow ? "flow" : `chat=${chatId || "(none)"}`}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (flow) { new FlowLiveSession(ws); return; }
      void new LiveSession(ws, chatId).start();
    });
  });
  return wss;
}
