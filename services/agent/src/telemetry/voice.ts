import type { TelemetryEventProps } from "@openlive/shared";
import { BENCH_TIMEOUT_TEXT, providersFor, type AccelEntry, type BenchResult } from "../voice/accel.js";
import { tier, type DeviceProfile, type Provider } from "../voice/device.js";
import type { NativeEngine } from "../voice/native-models.js";
import { emitEvent } from "./emit.js";

type Fault = TelemetryEventProps<"voice_engine_fault">;

/** Families and providers are closed sets in the engine catalog, and main checks them again. */
export const voiceFault = (family: string, kind: Fault["kind"], provider?: Provider): void =>
  emitEvent("voice_engine_fault", { engine_family: family as Fault["engine_family"], kind, ...(provider && { provider }) });

/** What a finished benchmark tells: a fault per provider that failed on its own, then the result. */
export function reportBench(e: NativeEngine, results: BenchResult[], entry: AccelEntry, device: DeviceProfile): void {
  try {
    sendBench(e, results, entry, device);
  } catch { /* a benchmark that finished is never undone by telemetry */ }
}

function sendBench(e: NativeEngine, results: BenchResult[], entry: AccelEntry, device: DeviceProfile): void {
  for (const r of results) {
    if (!("error" in r) || r.error.startsWith("skipped: ")) continue;
    voiceFault(e.family, r.error.startsWith(BENCH_TIMEOUT_TEXT) ? "bench_timeout" : "bench_failed", r.provider);
  }
  const rtf = (provider: Provider) => results.find((r) => r.provider === provider && "rtf" in r) as { rtf: number } | undefined;
  const cpu = rtf("cpu"), chosen = rtf(entry.chosen);
  emitEvent("voice_bench_result", {
    engine_family: e.family as Fault["engine_family"],
    engine_kind: e.kind,
    chosen_provider: entry.chosen,
    ...(cpu && { cpu_rtf: cpu.rtf }),
    ...(chosen && { chosen_rtf: chosen.rtf }),
    tier: tier(device),
    apple_silicon: !!device.appleSilicon,
    providers_available: providersFor(e, device).length,
  });
}
