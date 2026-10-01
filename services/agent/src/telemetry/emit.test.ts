import { afterEach, describe, expect, it } from "vitest";
import { emitEvent, emitFact } from "./emit.ts";

const setPort = (port: unknown) => { (process as unknown as { parentPort?: unknown }).parentPort = port; };
afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; });

describe("the agent's channel to main", () => {
  it("does nothing without a parent port, as in dev", () => {
    expect((process as unknown as { parentPort?: unknown }).parentPort).toBeUndefined();
    expect(() => emitEvent("tray_action", { action: "quit" })).not.toThrow();
    expect(() => emitFact("flow", { turns: 1 })).not.toThrow();
  });

  it("posts an event as the message main accepts", () => {
    const sent: unknown[] = [];
    setPort({ postMessage: (m: unknown) => sent.push(m) });
    emitEvent("flow_consent_result", { outcome: "granted", brain_kind: "api" });
    expect(sent).toEqual([{ openlive: "telemetry", v: 1, kind: "event", name: "flow_consent_result", props: { outcome: "granted", brain_kind: "api" } }]);
  });

  it("posts a fact under the scope main folds it into", () => {
    const sent: unknown[] = [];
    setPort({ postMessage: (m: unknown) => sent.push(m) });
    emitFact("flow", { turns: 1, t_see: 2 });
    emitFact("call", { lang: "es" });
    expect(sent).toEqual([
      { openlive: "telemetry", v: 1, kind: "fact", scope: "flow", props: { turns: 1, t_see: 2 } },
      { openlive: "telemetry", v: 1, kind: "fact", scope: "call", props: { lang: "es" } },
    ]);
  });

  it("never throws into the agent, whatever the port does", () => {
    setPort({ postMessage: () => { throw new Error("port closed"); } });
    expect(() => emitEvent("tray_action", { action: "quit" })).not.toThrow();
    expect(() => emitFact("call", { turns: 1 })).not.toThrow();
    setPort({ get postMessage() { throw new Error("no such thing"); } });
    expect(() => emitFact("call", { turns: 1 })).not.toThrow();
  });
});
