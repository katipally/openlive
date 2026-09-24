import { expect, it } from "vitest";
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
