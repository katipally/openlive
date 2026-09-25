import { afterEach, expect, it, vi } from "vitest";
import { LiveClient } from "./liveClient";

// A barge-in before any audio played cuts the reply to nothing, and nothing is a
// cut: dropped, the server would keep the whole reply the user never heard.
it("sends an empty cut, and leaves it out only when there is nothing to cut", () => {
  const client = new LiveClient({} as never);
  const sent: unknown[] = [];
  Object.assign(client, { ws: { readyState: WebSocket.OPEN, send: (s: string) => sent.push(JSON.parse(s)) } });
  client.cancel("");
  client.cancel();
  client.flowCancel("");
  client.flowCancel(undefined, true);
  expect(sent).toEqual([
    { t: "cancel", spoken: "" },
    { t: "cancel" },
    { t: "flow_cancel", spoken: "" },
    { t: "flow_cancel", close: true },
  ]);
});

afterEach(() => { vi.unstubAllGlobals(); });

// A barge-in's cancel and the next turn cross the server's last words for the
// cut one. Its done, arriving after the next turn went out, used to end that turn.
it("numbers each turn and drops the reply to any turn but the latest", () => {
  const sockets: FakeWs[] = [];
  class FakeWs {
    static OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  const got: string[] = [];
  const client = new LiveClient({ onSse: (e) => got.push(e.type), onFlow: (e) => got.push(`flow:${e.type}`) });
  client.connect("chat");
  const ws = sockets[0]!;
  const server = (m: unknown) => ws.onmessage!({ data: JSON.stringify(m) });

  client.userText("count to ten");
  client.userText("stop, count to three");
  server({ t: "sse", event: { type: "text_delta", text: "Four" }, turn: 1 });
  server({ t: "sse", event: { type: "done" }, turn: 1 });
  server({ t: "sse", event: { type: "status", text: "ready" } });
  server({ t: "sse", event: { type: "text_delta", text: "One" }, turn: 2 });
  client.flowText("and Flow counts the same way");
  server({ t: "flow", event: { type: "done", reason: "aborted" }, turn: 2 });
  server({ t: "flow", event: { type: "done", reason: "no_tools" }, turn: 3 });

  expect(ws.sent.map((m) => m.turn)).toEqual([1, 2, 3]);
  expect(got).toEqual(["status", "text_delta", "flow:done"]);
  client.close();
});

// A cancelled turn's ask that crossed the next turn on the wire must not open a
// chip in it, and its machine call is answered at once instead of run.
it("drops asks from any turn but the latest and answers their machine calls empty", () => {
  const sockets: FakeWs[] = [];
  class FakeWs {
    static OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  const got: string[] = [];
  const client = new LiveClient({
    onPermission: (reqId) => got.push(`permission:${reqId}`),
    onElicitation: (e) => got.push(`elicitation:${e.reqId}`),
    onToolBridge: (reqId) => got.push(`bridge:${reqId}`),
  });
  client.connect("chat");
  const ws = sockets[0]!;
  const server = (m: unknown) => ws.onmessage!({ data: JSON.stringify(m) });

  client.userText("delete the build folder");
  client.userText("no, just list it");
  server({ t: "permission", reqId: "p1", question: "Delete?", options: [], turn: 1 });
  server({ t: "elicitation", reqId: "e1", mode: "form", message: "Which?", turn: 1 });
  server({ t: "tool_bridge", reqId: "b1", op: "clipboard_read", turn: 1 });
  server({ t: "permission", reqId: "p2", question: "List?", options: [], turn: 2 });
  server({ t: "tool_bridge", reqId: "b2", op: "clipboard_read", turn: 2 });

  expect(got).toEqual(["permission:p2", "bridge:b2"]);
  expect(ws.sent.filter((m) => m.t === "tool_bridge_result")).toEqual([{ t: "tool_bridge_result", reqId: "b1", output: "" }]);
  client.close();
});
