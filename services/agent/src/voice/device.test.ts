import { describe, it, expect } from "vitest";
import {
  builtProviders, fingerprint, gpuVendor, linuxOnBattery, ortBuiltProviders, parseLspci, parseMacDisplays, parseNvidiaSmi, parsePmset, parseSysctl,
  parseWindowsProbe, physicalCoresFromCpuinfo, threadsFor, tier, usableProviders, type DeviceProfile,
} from "./device.js";

const GB = 2 ** 30;
const profile = (p: Partial<DeviceProfile>): DeviceProfile => ({
  os: "linux", osVersion: "", arch: "x64", cpu: "cpu", cores: 8, ramBytes: 16 * GB, freeRamBytes: 8 * GB, gpus: [], runtime: "sherpa-onnx 1.13.8 (cpu)", providers: ["cpu"], ...p,
});
const NVIDIA = { vendor: "nvidia" as const, model: "NVIDIA GeForce RTX 4070", driver: "560.94" };

// One device per platform the app ships to, as probeDevice would build it.
const DEVICES = {
  macArm64: profile({ os: "darwin", arch: "arm64", cpu: "Apple M4", cores: 10, physicalCores: 10, performanceCores: 4, appleSilicon: true, gpus: [{ vendor: "apple", model: "Apple M4" }] }),
  macX64: profile({ os: "darwin", arch: "x64", cpu: "Intel(R) Core(TM) i7-9750H", cores: 12, physicalCores: 6, appleSilicon: false, gpus: [{ vendor: "amd", model: "AMD Radeon Pro 5300M" }] }),
  winGpu: profile({ os: "win32", cpu: "AMD Ryzen 7 7700X", cores: 16, physicalCores: 8, gpus: [NVIDIA] }),
  winNoGpu: profile({ os: "win32", cpu: "Intel(R) Core(TM) i5-8250U", cores: 8, physicalCores: 4, ramBytes: 8 * GB }),
  linuxNvidia: profile({ os: "linux", cores: 32, physicalCores: 16, ramBytes: 64 * GB, gpus: [NVIDIA] }),
  linuxNoNvidia: profile({ os: "linux", cores: 4, physicalCores: 2, ramBytes: 4 * GB, gpus: [{ vendor: "intel", model: "Intel Corporation UHD Graphics 620" }] }),
  // Every probe failed: node:os facts only.
  nothing: profile({ os: "linux", cores: 1, ramBytes: 2 * GB, runtime: "sherpa-onnx unknown (cpu)" }),
};

// Library bytes as each prebuilt carries them (checked against sherpa-onnx 1.13.8).
const DARWIN_ORT = Buffer.from("...N11onnxruntime23CoreMLExecutionProviderE...");
const CPU_ORT = Buffer.from("...CPUExecutionProvider...");

describe("execution providers", () => {
  it("finds the providers compiled into a runtime build, and never loses cpu", () => {
    expect(builtProviders(DARWIN_ORT, ["libonnxruntime.dylib"])).toEqual(["cpu", "coreml"]);
    expect(builtProviders(CPU_ORT, ["onnxruntime.dll", "onnxruntime_providers_shared.dll"])).toEqual(["cpu"]);
    expect(builtProviders(Buffer.from(".?AVExecutionProvider@Dml@@"), ["onnxruntime.dll"])).toEqual(["cpu", "directml"]);
    expect(builtProviders(CPU_ORT, ["libonnxruntime.so", "libonnxruntime_providers_cuda.so"])).toEqual(["cpu", "cuda"]);
    expect(builtProviders(null, [])).toEqual(["cpu"]);
  });

  it("offers only what the build carries and the device can run", () => {
    expect(usableProviders(["cpu", "coreml"], DEVICES.macArm64)).toEqual(["cpu", "coreml"]);
    expect(usableProviders(["cpu", "coreml"], DEVICES.macX64)).toEqual(["cpu", "coreml"]);
    // The shipped win and linux builds are CPU only, whatever the GPU.
    for (const d of [DEVICES.winGpu, DEVICES.winNoGpu, DEVICES.linuxNvidia, DEVICES.linuxNoNvidia, DEVICES.nothing]) expect(usableProviders(["cpu"], d)).toEqual(["cpu"]);
    // A build that does carry a GPU provider is used only with a GPU for it.
    expect(usableProviders(["cpu", "directml"], DEVICES.winGpu)).toEqual(["cpu", "directml"]);
    expect(usableProviders(["cpu", "directml"], DEVICES.winNoGpu)).toEqual(["cpu"]);
    expect(usableProviders(["cpu", "cuda"], DEVICES.linuxNvidia)).toEqual(["cpu", "cuda"]);
    expect(usableProviders(["cpu", "cuda"], DEVICES.linuxNoNvidia)).toEqual(["cpu"]);
    expect(usableProviders(["cpu", "coreml"], DEVICES.linuxNvidia)).toEqual(["cpu"]);
    // WebGPU needs a GPU of any make.
    expect(usableProviders(["cpu", "webgpu", "coreml"], DEVICES.macArm64)).toEqual(["cpu", "webgpu", "coreml"]);
    expect(usableProviders(["cpu", "directml", "webgpu"], DEVICES.winNoGpu)).toEqual(["cpu"]);
    expect(usableProviders(["cpu", "webgpu"], DEVICES.nothing)).toEqual(["cpu"]);
  });

  it("reads onnxruntime-node's own list, counting an unbundled provider only once its library is there", () => {
    // listSupportedBackends() of onnxruntime-node 1.30.0 on macOS arm64 (2026-09-25).
    expect(ortBuiltProviders([{ name: "cpu", bundled: true }, { name: "webgpu", bundled: true }, { name: "coreml", bundled: true }], [])).toEqual(["cpu", "webgpu", "coreml"]);
    expect(ortBuiltProviders([{ name: "cpu", bundled: true }, { name: "dml", bundled: true }], ["DirectML.dll"])).toEqual(["cpu", "directml"]);
    const linux = [{ name: "cpu", bundled: true }, { name: "cuda", bundled: false }];
    expect(ortBuiltProviders(linux, ["libonnxruntime.so.1"])).toEqual(["cpu"]);
    expect(ortBuiltProviders(linux, ["libonnxruntime.so.1", "libonnxruntime_providers_cuda.so"])).toEqual(["cpu", "cuda"]);
    expect(ortBuiltProviders([{ name: "qnn", bundled: true }], [])).toEqual(["cpu"]);
  });
});

describe("threads and tier", () => {
  it("gives each engine its share of the fast cores, between 1 and 4", () => {
    expect(threadsFor(DEVICES.macArm64)).toBe(2); // half of 4 P-cores
    expect(threadsFor(DEVICES.macX64)).toBe(2); // a third of 6 physical
    expect(threadsFor(DEVICES.winGpu)).toBe(2);
    expect(threadsFor(DEVICES.winNoGpu)).toBe(1);
    expect(threadsFor(DEVICES.linuxNvidia)).toBe(4); // capped
    expect(threadsFor(DEVICES.linuxNoNvidia)).toBe(1);
    expect(threadsFor(DEVICES.nothing)).toBe(1);
    expect(threadsFor(profile({ cores: 24 }))).toBe(4); // physical unknown: half the logical ones
  });

  it("classes each device", () => {
    expect(tier(DEVICES.macArm64)).toBe("high");
    expect(tier(DEVICES.macX64)).toBe("mid");
    expect(tier(DEVICES.winGpu)).toBe("high");
    expect(tier(DEVICES.winNoGpu)).toBe("mid");
    expect(tier(DEVICES.linuxNvidia)).toBe("high");
    expect(tier(DEVICES.linuxNoNvidia)).toBe("low");
    expect(tier(DEVICES.nothing)).toBe("low");
  });

  it("fingerprints what results depend on, not what moves all day", () => {
    const d = DEVICES.macArm64;
    expect(fingerprint({ ...d, freeRamBytes: 1, onBattery: true })).toBe(fingerprint(d));
    expect(fingerprint({ ...d, runtime: "sherpa-onnx 1.14.0 (cpu, coreml)" })).not.toBe(fingerprint(d));
    expect(fingerprint({ ...d, osVersion: "macOS 28.0" })).not.toBe(fingerprint(d));
    expect(fingerprint({ ...DEVICES.winGpu, gpus: [{ ...NVIDIA, driver: "561.09" }] })).not.toBe(fingerprint(DEVICES.winGpu));
  });
});

describe("probe parsers", () => {
  it("reads macOS sysctl, system_profiler and pmset output", () => {
    expect(parseSysctl("hw.physicalcpu: 10\nhw.perflevel0.physicalcpu: 4\nhw.optional.arm64: 1\n")).toEqual({ "hw.physicalcpu": "10", "hw.perflevel0.physicalcpu": "4", "hw.optional.arm64": "1" });
    expect(parseSysctl("sysctl: unknown oid 'hw.perflevel0.physicalcpu'\nhw.physicalcpu: 6")).toEqual({ "hw.physicalcpu": "6" });
    expect(parseMacDisplays(JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M4", sppci_model: "Apple M4", spdisplays_vendor: "sppci_vendor_Apple" }] })))
      .toEqual([{ vendor: "apple", model: "Apple M4" }]);
    expect(parseMacDisplays(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Intel UHD Graphics 630", spdisplays_vendor: "sppci_vendor_intel" }, { sppci_model: "AMD Radeon Pro 5300M", spdisplays_vendor: "sppci_vendor_amd" }] }))
      .map((g) => g.vendor)).toEqual(["intel", "amd"]);
    expect(parseMacDisplays("")).toEqual([]);
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0")).toBe(true);
    expect(parsePmset("Now drawing from 'AC Power'")).toBe(false);
    expect(parsePmset("")).toBeUndefined();
  });

  it("reads the Windows CIM probe, one object or a list", () => {
    const one = JSON.stringify({ gpu: { Name: "NVIDIA GeForce RTX 4070", AdapterCompatibility: "NVIDIA", DriverVersion: "32.0.15.6094" }, cpu: { NumberOfCores: 8 }, battery: [] });
    expect(parseWindowsProbe(one)).toEqual({ gpus: [{ vendor: "nvidia", model: "NVIDIA GeForce RTX 4070", driver: "32.0.15.6094" }], physicalCores: 8, onBattery: undefined });
    const laptop = JSON.stringify({ gpu: [{ Name: "Microsoft Basic Display Adapter" }, { Name: "Intel(R) UHD Graphics", AdapterCompatibility: "Intel Corporation" }], cpu: [{ NumberOfCores: 4 }], battery: [{ BatteryStatus: 1 }] });
    expect(parseWindowsProbe(laptop)).toMatchObject({ gpus: [{ vendor: "intel" }], physicalCores: 4, onBattery: true });
    expect(parseWindowsProbe("")).toEqual({ gpus: [] });
  });

  it("reads nvidia-smi, lspci, /proc/cpuinfo and power_supply on Linux", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3090, 550.54.14\n")).toEqual([{ vendor: "nvidia", model: "NVIDIA GeForce RTX 3090", driver: "550.54.14" }]);
    expect(parseNvidiaSmi("")).toEqual([]);
    const lspci = '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-P GT2" -r0c "Lenovo" "Device 3f1a"\n00:1f.3 "Audio device" "Intel Corporation" "Alder Lake PCH-P"\n01:00.0 "3D controller" "NVIDIA Corporation" "GA107M" -ra1 "Lenovo" "Device 3f1a"';
    expect(parseLspci(lspci)).toEqual([{ vendor: "intel", model: "Intel Corporation Alder Lake-P GT2" }, { vendor: "nvidia", model: "NVIDIA Corporation GA107M" }]);
    const cpuinfo = ["processor: 0", "physical id: 0", "core id: 0", "", "processor: 1", "physical id: 0", "core id: 0", "", "processor: 2", "physical id: 0", "core id: 1", "", "processor: 3", "physical id: 1", "core id: 0"].join("\n");
    expect(physicalCoresFromCpuinfo(cpuinfo)).toBe(3);
    expect(physicalCoresFromCpuinfo("")).toBeUndefined();
    expect(linuxOnBattery([{ type: "Mains\n", online: "0\n" }, { type: "Battery\n", online: "" }])).toBe(true);
    expect(linuxOnBattery([{ type: "Mains", online: "1" }])).toBe(false);
    expect(linuxOnBattery([])).toBeUndefined();
  });

  it("names GPU vendors from any tool's spelling", () => {
    expect(["NVIDIA Corporation", "Advanced Micro Devices, Inc. [AMD/ATI]", "AMD Radeon RX 7800", "Intel(R) Arc(TM)", "sppci_vendor_Apple", "Matrox"].map(gpuVendor))
      .toEqual(["nvidia", "amd", "amd", "intel", "apple", "other"]);
  });
});
