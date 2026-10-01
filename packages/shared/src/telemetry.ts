import type {
  FeatureCounterKey,
  TelemetryEventName,
  TelemetryEventProps,
  TelemetryFactProps,
  TelemetryFactScope,
} from "./telemetry-schema";

// The channels around the desktop telemetry sender. Main folds facts and
// sends; renderers reach it through the preload bridge (P2), the agent
// through its parent port (P1).

/** Scopes a renderer may fold into: the orb window is never admitted. */
export type TelemetryRendererFactScope = Extract<TelemetryFactScope, "flow_owner" | "call_renderer">;
export type TelemetryFrom = "notice" | "settings";
/** Why Flow closed, as the owner reports it. Main adds `quit` itself. */
export type FlowCloseReason = "gesture" | "orb_button" | "idle" | "disarmed" | "sleep_or_lock" | "other";

type FeedbackProps = TelemetryEventProps<"feedback_given">;

/** A prompt main says may show now. The caps are checked and counted before it is handed out. */
export interface FeedbackOffer {
  kind: FeedbackProps["kind"];
  surface: FeedbackProps["surface"];
}

/** What the person did with a prompt. Main adds the kind, surface and context itself, so a page cannot name them. */
export interface FeedbackAnswer {
  outcome: FeedbackProps["outcome"];
  rating?: FeedbackProps["rating"];
  score?: FeedbackProps["score"];
  reason?: FeedbackProps["reason"];
}

export interface TelemetryStatus {
  /** False in dev, tests, debug runs, unstamped builds and with an env opt-out: nothing below applies then. */
  active: boolean;
  enabled: boolean;
  /** The first-run notice was displayed: sending may start. */
  noticeSeen: boolean;
  /** Last characters of the install ID, so a person can tell two installs apart. Empty when there is none. */
  installIdTail: string;
  /** The install's random, read-only name (adjective-animal-xxxxxxxx), derived from the install ID. Empty when there is no ID. */
  username: string;
  /** Whether the app may ask for feedback. "Don't ask again" turns it off for good; this turns it back on. */
  feedback: boolean;
  appVersion: string;
  osName: string;
  osMajor: string;
}

/** `window.openlive.telemetry`. Every call is safe to make without a listener on the other side. */
export interface TelemetryBridge {
  track<E extends TelemetryEventName>(name: E, props: TelemetryEventProps<E>): void;
  fact<S extends TelemetryRendererFactScope>(scope: S, props: TelemetryFactProps<S>): void;
  count(key: FeatureCounterKey): void;
  noticeShown(): void;
  get(): Promise<TelemetryStatus>;
  set(enabled: boolean, from: TelemetryFrom): Promise<void>;
  /** The prompt to show now, or null. Null whenever sharing is off, the notice is owed, a session is open or a cap says wait. */
  feedbackNext(): Promise<FeedbackOffer | null>;
  feedbackAnswer(answer: FeedbackAnswer): void;
  setFeedback(allowed: boolean): Promise<void>;
}

/** P1: what the agent posts on `process.parentPort`. */
export type TelemetryAgentMessage = { openlive: "telemetry"; v: 1 } & (
  | { [E in TelemetryEventName]: { kind: "event"; name: E; props: TelemetryEventProps<E> } }[TelemetryEventName]
  | { kind: "fact"; scope: "flow"; props: TelemetryFactProps<"agent_flow"> }
  | { kind: "fact"; scope: "call"; props: TelemetryFactProps<"agent_call"> }
);

export const telemetryEvent = <E extends TelemetryEventName>(name: E, props: TelemetryEventProps<E>) =>
  ({ openlive: "telemetry", v: 1, kind: "event", name, props }) as TelemetryAgentMessage;

export const telemetryFact = <S extends "flow" | "call">(
  scope: S,
  props: TelemetryFactProps<S extends "flow" ? "agent_flow" : "agent_call">,
) => ({ openlive: "telemetry", v: 1, kind: "fact", scope, props }) as TelemetryAgentMessage;
