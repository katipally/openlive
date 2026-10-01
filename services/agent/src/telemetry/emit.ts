import { telemetryEvent, telemetryFact, type TelemetryEventName, type TelemetryEventProps, type TelemetryFactProps } from "@openlive/shared";

// The agent's one channel to Electron main. Only enums, booleans and rounded
// numbers named in the shared schema go through it, and main validates them
// again. Packaged, the agent is a utility process with a `parentPort`; in dev it
// is not, so everything here is a no-op.

type Port = { postMessage(message: unknown): void };

const post = (message: unknown): void => {
  try {
    (process as unknown as { parentPort?: Port }).parentPort?.postMessage(message);
  } catch { /* telemetry never breaks the agent */ }
};

export type AgentFactProps<S extends "flow" | "call"> = TelemetryFactProps<S extends "flow" ? "agent_flow" : "agent_call">;

export const emitEvent = <E extends TelemetryEventName>(name: E, props: TelemetryEventProps<E>): void =>
  post(telemetryEvent(name, props));

/** A delta folded into the open Flow or call record in main. */
export const emitFact = <S extends "flow" | "call">(scope: S, props: AgentFactProps<S>): void =>
  post(telemetryFact(scope, props));
