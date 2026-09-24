// Custom web server. Next handles all HTTP as usual; we add ONE thing it can't:
// a WebSocket at /live that we proxy to the internal agent service. On Hugging
// Face Spaces only this web port is public, so the browser reaches the agent's
// live socket through here (adding the shared secret the browser must not hold).
import { createServer } from "node:http";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const AGENT_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8787";
const SECRET = (process.env.OPENLIVE_AGENT_SECRET || "").trim(); // trim to match the agent's own .trim()

const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler(); // Next's own HMR/websocket upgrade handler

const server = createServer((req, res) => { const r = handle(req, res); keepOnlyOurUpgrade(); return r; });
const wss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades: /live and /voice/stream → the agent proxy, everything else → Next.
const onUpgrade = (req, socket, head) => {
  let pathname = "/", search = "";
  try { const u = new URL(req.url ?? "", "http://localhost"); pathname = u.pathname; search = u.search; } catch { /* keep defaults */ }
  if (pathname === "/live" || pathname === "/voice/stream") wss.handleUpgrade(req, socket, head, (client) => proxyLive(client, pathname, search));
  else upgrade(req, socket, head);
};
// Next LAZILY attaches its OWN 'upgrade' listener to our server on the first HTTP
// request (getRequestHandler → setupWebSocketHandler → req.socket.server), and its
// handler DESTROYS any WS path it doesn't own — including /live, which closed the
// live socket ~2ms after it opened. So after each request, strip every upgrade
// listener except ours (we already forward non-/live upgrades to Next above).
const keepOnlyOurUpgrade = () => {
  for (const l of server.listeners("upgrade")) if (l !== onUpgrade) server.removeListener("upgrade", l);
};
server.on("upgrade", onUpgrade);

// Bridge the browser socket to the agent's /live socket, both directions. This
// path ONLY runs in the container / behind HF's edge — never in local dev (which
// connects the browser straight to the agent) — so it logs which side drops first
// (with code+reason+timing) to make otherwise-blind failures diagnosable, and it
// tells the browser WHY before closing so the UI can show a real error.
function proxyLive(client, pathname, search) {
  const target = AGENT_URL.replace(/^http/, "ws") + pathname + search;
  const upstream = new WebSocket(target, { headers: { "x-openlive-secret": SECRET } });
  const t0 = Date.now();
  const queue = [];
  let closed = false;

  const tellClient = (message) => {
    try { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ t: "error", message })); } catch { /* */ }
  };
  const shutdown = (why, clientCode) => {
    if (closed) return; closed = true;
    console.log(`[web] live closed after ${Date.now() - t0}ms — ${why}`);
    // close() throws "closed before established" on a still-CONNECTING socket, so
    // terminate() those instead; only gracefully close() an OPEN one.
    try { if (client.readyState === WebSocket.OPEN) client.close(clientCode ?? 1011, String(why).slice(0, 120)); else client.terminate(); } catch { /* */ }
    try { if (upstream.readyState === WebSocket.OPEN) upstream.close(); else upstream.terminate(); } catch { /* */ }
  };

  upstream.on("open", () => { for (const [d, b] of queue) upstream.send(d, { binary: b }); queue.length = 0; });
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queue.push([data, isBinary]);
  });
  upstream.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });

  client.on("close", (code, reason) => shutdown(`browser closed (code=${code}${reason?.length ? ` reason=${reason}` : ""})`));
  client.on("error", (e) => shutdown(`browser error: ${e.message}`));
  upstream.on("close", (code, reason) => shutdown(`agent closed (code=${code}${reason?.length ? ` reason=${reason}` : ""})`));
  upstream.on("unexpected-response", (_req, res) => { tellClient(`The live agent rejected the connection (HTTP ${res.statusCode}).`); shutdown(`agent HTTP ${res.statusCode}`); });
  upstream.on("error", (e) => { tellClient("Couldn't reach the live agent."); shutdown(`agent error: ${e.message}`); });
}

server.listen(port, hostname, () => console.log(`▸ OpenLive web on http://${hostname}:${port}`));
