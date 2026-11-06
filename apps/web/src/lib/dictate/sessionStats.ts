/** Most latency samples kept for one session; later dictations are not measured. */
export const SAMPLE_CAP = 200;
/** Latencies are sent to this step and no higher. */
export const LATENCY_STEP_MS = 50;
export const LATENCY_MAX_MS = 30000;

/** A latency as it is reported: rounded to the step, never above the cap. */
export const bucketLatency = (ms: number) => Math.min(LATENCY_MAX_MS, Math.max(0, Math.round(ms / LATENCY_STEP_MS) * LATENCY_STEP_MS));

/** The p50 and p90 of a session's samples, bucketed; null with none. O(n log n). */
export function latencyPercentiles(samples: readonly number[]): { p50: number; p90: number } | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => bucketLatency(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!);
  return { p50: at(0.5), p90: at(0.9) };
}
