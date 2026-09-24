import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

// The /live upgrade gate: with OPENLIVE_AGENT_SECRET set, a connection must
// present the secret as the x-openlive-secret header (web proxy) OR the
// ?token= query param (desktop renderer — browser WS can't set headers).
// LiveSession is heavyweight, so stub the module before importing ws.ts.
import { vi } from "vitest";
vi.mock("./session.js", () => ({
  LiveSession: class { constructor(private ws: WebSocket) {} async start() { /* accept and idle */ } },
}));
vi.mock("./flow-ws.js", () => ({
  FlowLiveSession: class { constructor(private ws: WebSocket) { flowConnections++; } },
}));
let flowConnections = 0;

const SECRET = "gate-test-secret";
let server: Server;
let port: number;

beforeAll(async () => {
  process.env.OPENLIVE_AGENT_SECRET = SECRET;
  const { attachLiveWs } = await import("./ws.js");
  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachLiveWs(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  delete process.env.OPENLIVE_AGENT_SECRET;
  await new Promise((r) => server.close(r));
});

function attempt(path: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const done = (r: string) => { try { ws.terminate(); } catch { /* */ } res(r); };
    ws.on("open", () => done("accepted"));
    ws.on("unexpected-response", (_q, r) => done(`rejected ${r.statusCode}`));
    ws.on("error", (e) => done(`error ${e.message}`));
    setTimeout(() => done("timeout"), 2000);
  });
}

describe("/live upgrade gate", () => {
  it("rejects with no credential", async () => {
    expect(await attempt("/live?chat=x")).toMatch(/rejected 401|error.*401/);
  });
  it("rejects a wrong query token", async () => {
    expect(await attempt(`/live?chat=x&token=nope`)).toMatch(/rejected 401|error.*401/);
  });
  it("accepts the correct query token", async () => {
    expect(await attempt(`/live?chat=x&token=${SECRET}`)).toBe("accepted");
  });
  it("accepts the correct header", async () => {
    expect(await attempt("/live?chat=x", { "x-openlive-secret": SECRET })).toBe("accepted");
  });
  it("rejects a token of a different length without throwing", async () => {
    expect(await attempt(`/live?chat=x&token=${SECRET}${SECRET}`)).toMatch(/rejected 401|error.*401/);
  });
  it("routes ?flow=1 to the Flow session, not to chat", async () => {
    const before = flowConnections;
    expect(await attempt(`/live?flow=1&token=${SECRET}`)).toBe("accepted");
    expect(flowConnections).toBe(before + 1);
  });
  it("gates /voice/stream the same way and routes it to the ASR socket", async () => {
    expect(await attempt("/voice/stream?engine=nemotron")).toMatch(/rejected 401|error.*401/);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream?engine=parakeet&token=${SECRET}`);
    const [msg, code] = await new Promise<[string, number]>((res) => {
      let first = "";
      ws.on("message", (d) => { first ||= String(d); });
      ws.on("close", (c) => res([first, c]));
    });
    expect(JSON.parse(msg)).toEqual({ type: "error", error: "unknown streaming engine" });
    expect(code).toBe(1008);
  });
});

describe("the dev gate with no secret", () => {
  it("lets this machine's pages and non-browser clients in, and nobody else", async () => {
    const { loopbackOrigin } = await import("./ws.js");
    expect(loopbackOrigin(undefined)).toBe(true);
    expect(loopbackOrigin("http://localhost:3000")).toBe(true);
    expect(loopbackOrigin("http://127.0.0.1:47834")).toBe(true);
    expect(loopbackOrigin("https://example.com")).toBe(false);
    expect(loopbackOrigin("http://localhost.example.com")).toBe(false);
    expect(loopbackOrigin("null")).toBe(false);
  });
});
