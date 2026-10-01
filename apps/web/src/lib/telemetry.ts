import {
  eventLimit,
  type FeatureCounterKey,
  type FeedbackAnswer,
  type FeedbackOffer,
  type TelemetryBridge,
  type TelemetryEventName,
  type TelemetryEventProps,
  type TelemetryFactProps,
  type TelemetryFrom,
  type TelemetryRendererFactScope,
  type TelemetryStatus,
} from "@openlive/shared";

// The renderer's side of product-usage telemetry. Only the desktop shell can
// send anything (the CSP blocks the renderer), so every call here hands a typed
// message to `window.openlive.telemetry` and is a no-op in a browser tab. None
// of them throws or waits: telemetry must never be able to break the app.

const bridge = (): TelemetryBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { openlive?: { telemetry?: TelemetryBridge } }).openlive?.telemetry;

// Once-only events already handed over, so a call site that runs on every
// open does not cost an IPC message each time. Main stays the authority.
const handedOver = new Set<string>();

const quietly = (fn: () => unknown): void => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(() => {});
  } catch {}
};

export const telemetry = {
  track<E extends TelemetryEventName>(name: E, props: TelemetryEventProps<E>): void {
    const b = bridge();
    if (!b) return;
    const limit = eventLimit(name);
    const once = limit?.oncePerInstall ? name : limit?.oncePerValueOf ? `${name}:${(props as Record<string, unknown>)[limit.oncePerValueOf]}` : "";
    if (once && handedOver.has(once)) return;
    if (once) handedOver.add(once);
    quietly(() => b.track(name, props));
  },
  fact<S extends TelemetryRendererFactScope>(scope: S, props: TelemetryFactProps<S>): void {
    quietly(() => bridge()?.fact(scope, props));
  },
  count(key: FeatureCounterKey): void {
    quietly(() => bridge()?.count(key));
  },
  noticeShown(): void {
    quietly(() => bridge()?.noticeShown());
  },
  /** Null when there is no desktop shell to ask. */
  async get(): Promise<TelemetryStatus | null> {
    try {
      return (await bridge()?.get()) ?? null;
    } catch {
      return null;
    }
  },
  async set(enabled: boolean, from: TelemetryFrom): Promise<void> {
    try {
      await bridge()?.set(enabled, from);
    } catch {}
  },
  /** The prompt the desktop app allows right now, or null: no shell, sharing off, or a cap says wait. */
  async feedbackNext(): Promise<FeedbackOffer | null> {
    try {
      return (await bridge()?.feedbackNext()) ?? null;
    } catch {
      return null;
    }
  },
  feedbackAnswer(answer: FeedbackAnswer): void {
    quietly(() => bridge()?.feedbackAnswer(answer));
  },
  async setFeedback(allowed: boolean): Promise<void> {
    try {
      await bridge()?.setFeedback(allowed);
    } catch {}
  },
};
