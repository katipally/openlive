import type { TelemetryEventProps } from "@openlive/shared";
import { useUi } from "@/lib/uiStore";
import { telemetry } from "./telemetry";

// A JavaScript fault in this window, reported as its kind and where the person
// was, never what it said: not the message, the stack or the reason. The shell
// caps it (3 a launch a surface); the gap here keeps a rejection storm from
// costing an IPC message each.

type Props = TelemetryEventProps<"renderer_error">;
const GAP_MS = 10 * 60_000;
const lastSent = new Map<Props["kind"], number>();

/** Main window or Flow owner. The orb window is display only and is not admitted. */
const surface = (): Props["surface"] | undefined => {
  const path = window.location.pathname;
  return /^\/flow-owner(\/|$)/.test(path) ? "owner" : /^\/flow(\/|$)/.test(path) ? undefined : "main";
};

const during = (s: Props["surface"]): Props["during"] => {
  if (s === "owner") return "flow";
  const { liveOpen, mode } = useUi.getState();
  return liveOpen ? "call" : mode === "flow" ? "flow" : "other";
};

export function trackRendererError(kind: Props["kind"]): void {
  try {
    const s = surface();
    const now = Date.now();
    if (!s || now - (lastSent.get(kind) ?? -GAP_MS) < GAP_MS) return;
    lastSent.set(kind, now);
    telemetry.track("renderer_error", { surface: s, kind, during: during(s) });
  } catch {}
}

const aborted = (x: unknown) => (x as { name?: unknown } | null)?.name === "AbortError";

/** Listens for uncaught errors and unhandled rejections. An error event without an error object (the
 *  browser's own ResizeObserver notice, a cross-origin script) is not a fault of ours, and an abort is a cancel. */
export function watchRendererErrors(): () => void {
  const onError = (e: ErrorEvent) => { if (e.error && !aborted(e.error)) trackRendererError("uncaught"); };
  const onRejection = (e: PromiseRejectionEvent) => { if (!aborted(e.reason)) trackRendererError("unhandled_rejection"); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
