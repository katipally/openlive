import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceProfile } from "./device.js";

// DATA_DIR is resolved when @openlive/db loads, so point it at a temp dir first.
let dir: string;
let a: typeof import("./accel.js");
let m: typeof import("./native-models.js");

const mac: DeviceProfile = {
  os: "darwin", osVersion: "macOS 27.0", arch: "arm64", cpu: "Apple M4", cores: 10, physicalCores: 10, performanceCores: 4, appleSilicon: true,
  ramBytes: 16 * 2 ** 30, freeRamBytes: 2 ** 30, gpus: [{ vendor: "apple", model: "Apple M4" }], runtime: "sherpa-onnx 1.13.8 (cpu, coreml)", providers: ["cpu", "coreml"],
};
const windows: DeviceProfile = { ...mac, os: "win32", osVersion: "Windows 10.0.22631", arch: "x64", cpu: "AMD Ryzen 7 7700X", cores: 16, physicalCores: 8,
  performanceCores: undefined, appleSilicon: undefined, gpus: [{ vendor: "nvidia", model: "RTX 4070" }], runtime: "sherpa-onnx 1.13.8 (cpu)", providers: ["cpu"] };
const run = (provider: "cpu" | "coreml", rtf: number) => ({ provider, loadMs: 100, warmMs: 50, firstMs: 40, rtf });

const install = (id: string, content = "x") => {
  const e = m.nativeEngine(id)!;
  for (const f of e.files) { const p = join(m.engineDir(e.id), f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); }
  return e;
};
const load = async () => {
  vi.resetModules();
  m = await import("./native-models.js");
  a = await import("./accel.js");
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-accel-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  await load();
});
afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  rmSync(join(dir, "voice-accel.json"), { force: true });
  await load();
  await a.refreshDevice(async () => mac);
});

describe("chooseProvider", () => {
  it("takes an accelerator only when it beats CPU's rtf by 20% or more", () => {
    expect(a.chooseProvider([run("cpu", 0.1), run("coreml", 0.08)])).toBe("coreml");
    expect(a.chooseProvider([run("cpu", 0.1), run("coreml", 0.081)])).toBe("cpu");
    expect(a.chooseProvider([run("cpu", 0.1), run("coreml", 0.2)])).toBe("cpu");
  });

  it("stays on CPU when a provider errored, or CPU itself has no clean run", () => {
    expect(a.chooseProvider([run("cpu", 0.1), { provider: "coreml", error: "Unable to get shape for output" }])).toBe("cpu");
    expect(a.chooseProvider([{ provider: "cpu", error: "x" }, run("coreml", 0.01)])).toBe("cpu");
    expect(a.chooseProvider([])).toBe("cpu");
  });
});

describe("the per-device cache", () => {
  it("runs on CPU, on the device's thread share, until a benchmark says otherwise", () => {
    const e = install("kitten-nano-int8");
    expect(a.accelFor(e)).toEqual({ provider: "cpu", numThreads: 2 });
    expect(a.needsBench(e)).toBe(true);
    a.finishBench(e, [run("cpu", 0.15), run("coreml", 0.05)]);
    expect(a.accelFor(e).provider).toBe("coreml");
    expect(a.needsBench(e)).toBe(false);
  });

  it("keeps a result across restarts, and measures again when the device, runtime or model changes", async () => {
    const e = install("kitten-nano-int8");
    a.finishBench(e, [run("cpu", 0.15), run("coreml", 0.05)]);
    await load();
    expect(a.accelFor(m.nativeEngine(e.id)!).provider).toBe("coreml");

    await a.refreshDevice(async () => ({ ...mac, runtime: "sherpa-onnx 1.14.0 (cpu, coreml)" }));
    expect(a.measured(e)).toBeUndefined();
    expect(a.accelFor(e).provider).toBe("cpu");

    await a.refreshDevice(async () => mac);
    expect(a.measured(e)?.chosen).toBe("coreml");
    install("kitten-nano-int8", "a re-download of another size");
    expect(a.measured(e)).toBeUndefined();
  });

  it("never benchmarks a device with no accelerator, and ignores an override it cannot run", async () => {
    const e = install("moonshine-tiny-en-int8");
    await a.refreshDevice(async () => windows);
    expect(a.needsBench(e)).toBe(false);
    a.setOverride(e, "coreml");
    expect(a.accelFor(e)).toEqual({ provider: "cpu", numThreads: 2 });
  });

  it("honours the user's override over the benchmark, and auto puts the benchmark back", () => {
    const e = install("kitten-nano-int8");
    a.finishBench(e, [run("cpu", 0.15), run("coreml", 0.05)]);
    a.setOverride(e, "cpu");
    expect(a.accelFor(e).provider).toBe("cpu");
    expect(a.accelStatus(e).override).toBe("cpu");
    a.setOverride(e, "auto");
    expect(a.accelFor(e).provider).toBe("coreml");
  });

  it("retires a provider that fails in a real call, even one the user picked", () => {
    const e = install("kitten-nano-int8");
    a.finishBench(e, [run("cpu", 0.15), run("coreml", 0.05)]);
    a.setOverride(e, "coreml");
    a.markFailed(e, "coreml", "model_builder.cc: Unable to get shape");
    expect(a.accelFor(e).provider).toBe("cpu");
    expect(a.measured(e)?.results).toEqual([run("cpu", 0.15), { provider: "coreml", error: "model_builder.cc: Unable to get shape" }]);
    expect(a.needsBench(e)).toBe(false);
  });

  it("gives up on a benchmark that never finished twice, as one that crashed the process would", async () => {
    const e = install("kitten-nano-int8");
    expect(a.startBench(e)).toBe(true);
    await load(); // the process died mid-benchmark
    expect(a.startBench(e)).toBe(true);
    await load();
    expect(a.startBench(e)).toBe(false);
    expect(a.measured(e)).toMatchObject({ chosen: "cpu", results: [{ provider: "coreml", error: expect.stringContaining("never finished") }] });
  });

  it("forgets an interrupted benchmark rather than counting it", () => {
    const e = install("kitten-nano-int8");
    a.startBench(e);
    a.finishBench(e, null);
    a.startBench(e);
    a.finishBench(e, null);
    expect(a.startBench(e)).toBe(true);
  });
});

describe("an onnxruntime-node engine (Supertonic)", () => {
  const withOrt = { ...mac, ortRuntime: "onnxruntime-node 1.30.0 (cpu, webgpu, coreml)", ortProviders: ["cpu", "webgpu", "coreml"] as DeviceProfile["providers"] };

  it("is measured on that runtime's providers, not sherpa's", async () => {
    const e = install("supertonic-3");
    await a.refreshDevice(async () => withOrt);
    expect(a.accelStatus(e).providers).toEqual(["cpu", "webgpu", "coreml"]);
    expect(a.needsBench(e)).toBe(true);
    a.finishBench(e, [run("cpu", 0.17), { provider: "webgpu", loadMs: 300, warmMs: 440, firstMs: 410, rtf: 0.056 }, run("coreml", 0.13)]);
    expect(a.accelFor(e).provider).toBe("webgpu");
    a.setOverride(e, "coreml");
    expect(a.accelFor(e).provider).toBe("coreml");
  });

  it("stays on CPU, never benchmarked, where the runtime is missing or has CPU alone", async () => {
    const e = install("supertonic-3");
    for (const d of [mac, { ...withOrt, ortRuntime: "onnxruntime-node unavailable", ortProviders: [] }, { ...withOrt, ortProviders: ["cpu"] as DeviceProfile["providers"] }]) {
      await a.refreshDevice(async () => d);
      expect(a.needsBench(e)).toBe(false);
      a.setOverride(e, "webgpu");
      expect(a.accelFor(e).provider).toBe("cpu");
      a.setOverride(e, "auto");
    }
  });

  it("measures again when onnxruntime-node changes, and only its engines do", async () => {
    const st = install("supertonic-3"), kitten = install("kitten-nano-int8");
    await a.refreshDevice(async () => withOrt);
    a.finishBench(st, [run("cpu", 0.17), run("coreml", 0.05)]);
    a.finishBench(kitten, [run("cpu", 0.15), run("coreml", 0.05)]);
    await a.refreshDevice(async () => ({ ...withOrt, ortRuntime: "onnxruntime-node 1.31.0 (cpu, webgpu, coreml)" }));
    expect(a.measured(st)).toBeUndefined();
    expect(a.measured(kitten)?.chosen).toBe("coreml");
  });
});

describe("benchAudio", () => {
  it("is the same clip every time, speech-level and never clipped", () => {
    const x = a.benchAudio(1), y = a.benchAudio(1);
    expect(x).toEqual(y);
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(0.1);
    expect(x.some((v) => v !== 0)).toBe(true);
  });
});
