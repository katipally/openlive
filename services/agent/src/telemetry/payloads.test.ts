// What the agent sends is checked against main's own validator, so a value the
// schema would drop, or a name it does not know, fails here and not in the field.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_CLASSES } from "@openlive/shared";
import { NATIVE_ENGINES, NATIVE_FAMILIES } from "../voice/native-models.ts";
import type { BenchResult } from "../voice/accel.ts";
import type { DeviceProfile } from "../voice/device.ts";
import { callToolFact, flowToolFact, permissionFact, reportBrainError, reportException, type PermissionOutcome } from "./facts.ts";
import { limits } from "./limits.ts";
import { reportBench, voiceFault } from "./voice.ts";

const { validateEvent, validateFact } = createRequire(import.meta.url)("../../../../apps/desktop/telemetry/validate.cjs");

type Sent = { openlive: string; v: number; kind: "event" | "fact"; name?: string; scope?: "flow" | "call"; props: Record<string, unknown> };
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  limits.clear();
  (process as unknown as { parentPort?: unknown }).parentPort = { postMessage: (m: Sent) => sent.push(m) };
});
afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; });

/** Every message survives the validator whole: nothing dropped, nothing rounded away. */
function expectAccepted(): void {
  expect(sent.length).toBeGreaterThan(0);
  for (const m of sent) {
    expect(m).toMatchObject({ openlive: "telemetry", v: 1 });
    const clean = m.kind === "event" ? validateEvent(m.name, m.props) : validateFact(m.scope === "flow" ? "agent_flow" : "agent_call", m.props);
    expect(clean, JSON.stringify(m)).toEqual(m.props);
  }
}

describe("facts", () => {
  it("accept every Flow tool group and count", () => {
    for (const tool of ["insert_text", "read_selection", "screenshot", "click", "keypress", "window_close", "open_app", "shell", "remember", "camera_frame", "made_up"]) {
      flowToolFact(tool, false);
      flowToolFact(tool, true);
    }
    expectAccepted();
  });

  it("accept every call tool group", () => {
    for (const tool of ["look", "clipboard_read", "open_url", "list_dir", "delegate", "update_todos", "remember"]) callToolFact(tool);
    expectAccepted();
  });

  it("accept every permission outcome on both surfaces", () => {
    const outcomes: PermissionOutcome[] = ["allowed_once", "allowed_always", "rejected", "timeout", "cancelled"];
    for (const o of outcomes) { permissionFact("flow", o); permissionFact("call", o); }
    permissionFact("flow", "auto_allowed");
    expectAccepted();
  });

  it("accept the per-turn and per-event props the sessions send", () => {
    const flow = { brain_kind: "acp", brain_id: "claude-code", turns: 1, quiet_turns: 1, steered: 1, consent: true, agent_start_ms: 0, ttft_ms: 420, turn_ms: 3100, agent_tools: 3, agent_tools_failed: 1, agent_restarts: 1 };
    const call = { brain_kind: "api", brain_id: "ollama-cloud", turns: 1, lang: "ko", agent_start_ms: 1830, ttft_ms: 120, turn_ms: 900, interrupted: 1, camera_used: true, screen_used: true, elicitations: 1, resumed: "fell_back", errors: 1, agent_tools: 2 };
    (process as unknown as { parentPort: { postMessage(m: unknown): void } }).parentPort.postMessage({ openlive: "telemetry", v: 1, kind: "fact", scope: "flow", props: flow });
    (process as unknown as { parentPort: { postMessage(m: unknown): void } }).parentPort.postMessage({ openlive: "telemetry", v: 1, kind: "fact", scope: "call", props: call });
    expectAccepted();
  });
});

describe("events", () => {
  it("accept brain_error for every class and brain", () => {
    for (const cls of ERROR_CLASSES) {
      reportBrainError("flow", { brain_kind: cls.startsWith("agent_") ? "acp" : "api", brain_id: cls.startsWith("agent_") ? "hermes" : "perplexity" }, cls, { http: "4xx", recovered: false });
      reportBrainError("call", { brain_kind: "api", brain_id: "openrouter" }, cls);
    }
    expectAccepted();
    expect(sent.filter((m) => m.kind === "event")).toHaveLength(ERROR_CLASSES.length * 2);
  });

  it("accept main_exception", () => {
    reportException("uncaught");
    reportException("unhandled_rejection");
    expectAccepted();
  });

  it("know every engine family the catalog can name, with every fault kind", () => {
    for (const family of NATIVE_FAMILIES) {
      for (const kind of ["worker_crash", "accel_fallback", "bench_timeout", "bench_failed"] as const) voiceFault(family.id, kind, "coreml");
      voiceFault(family.id, "worker_crash");
    }
    expectAccepted();
  });

  it("accept a benchmark result for every engine kind, and the faults a failed provider adds", () => {
    const device = { os: "darwin", osVersion: "macOS 26", arch: "arm64", cpu: "Apple M4", cores: 10, physicalCores: 10, performanceCores: 4, appleSilicon: true, ramBytes: 16 * 2 ** 30, freeRamBytes: 2 ** 30, gpus: [], runtime: "x", providers: ["cpu", "coreml"] } as DeviceProfile;
    const run = (provider: "cpu" | "coreml", rtf: number): BenchResult => ({ provider, loadMs: 1, warmMs: 2, firstMs: 3, rtf });
    for (const kind of ["asr", "tts", "speaker", "addressee"] as const) {
      const e = NATIVE_ENGINES.find((x) => x.kind === kind)!;
      reportBench(e, [run("cpu", 0.15), run("coreml", 0.05)], { key: "k", chosen: "coreml", results: [], at: "" }, device);
    }
    const tts = NATIVE_ENGINES.find((x) => x.kind === "tts")!;
    reportBench(tts, [run("cpu", 0.15), { provider: "coreml", error: "benchmark timed out after 28 s" }], { key: "k", chosen: "cpu", results: [], at: "" }, device);
    reportBench(tts, [run("cpu", 0.15), { provider: "coreml", error: "skipped: CPU did not finish" }], { key: "k", chosen: "cpu", results: [], at: "" }, device);
    expectAccepted();
    const faults = sent.filter((m) => m.name === "voice_engine_fault").map((m) => m.props.kind);
    expect(faults).toEqual(["bench_timeout"]);
    expect(validateEvent("voice_bench_result", { engine_family: "kitten", engine_kind: "tts", chosen_provider: "cpu", cpu_rtf: 0.153 })).toMatchObject({ cpu_rtf: 0.15 });
    expect(sent.find((m) => m.name === "voice_bench_result")!.props).toMatchObject({ chosen_provider: "coreml", cpu_rtf: 0.15, chosen_rtf: 0.05, tier: "high", apple_silicon: true, providers_available: 2 });
  });
});
