import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";

// What this machine is, probed once per agent start: the facts native speech
// needs to pick threads, execution providers and a performance tier. Every
// probe runs locally, has a timeout and may fail; a failed one leaves its field
// out and the choices fall back to CPU and conservative threads.

export type Provider = "cpu" | "coreml" | "cuda" | "directml" | "webgpu";
export type Tier = "low" | "mid" | "high";
export type GpuVendor = "apple" | "nvidia" | "amd" | "intel" | "other";
export interface Gpu { vendor: GpuVendor; model: string; driver?: string }
export interface DeviceProfile {
  os: NodeJS.Platform;
  osVersion: string;
  arch: string;
  cpu: string;
  cores: number; // logical, as the OS schedules them (availableParallelism)
  physicalCores?: number;
  performanceCores?: number; // Apple Silicon P-cores; the E-cores are several times slower
  appleSilicon?: boolean;
  ramBytes: number;
  freeRamBytes: number;
  gpus: Gpu[];
  onBattery?: boolean;
  runtime: string; // sherpa-onnx version and the execution providers its ONNX Runtime was built with
  providers: Provider[]; // of those, the ones this device can use; always starts with cpu
  // The same for onnxruntime-node (the engines of native-models.ts onOrt); no
  // providers when its binary cannot load here (it ships none for Intel Macs).
  ortRuntime?: string;
  ortProviders?: Provider[];
}

/** Resolves stdout, or "" on a missing tool, timeout or failure. sysctl exits
 *  1 on one unknown name yet prints the rest, so stdout is kept then too. */
const run = (cmd: string, args: string[], timeout = 4000) => new Promise<string>((res) => {
  try { execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (_err, stdout) => res(String(stdout ?? ""))); } catch { res(""); }
});
const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const int = (s: string | undefined) => { const n = Number.parseInt(s ?? "", 10); return Number.isFinite(n) && n > 0 ? n : undefined; };

export function gpuVendor(name: string): GpuVendor {
  const n = name.toLowerCase();
  return n.includes("nvidia") ? "nvidia" : /\bamd\b|\bati\b|radeon|advanced micro/.test(n) ? "amd" : n.includes("intel") ? "intel" : n.includes("apple") ? "apple" : "other";
}

// ── parsers, pure so the tests feed them each OS's real output ──────────────
/** `sysctl name ...` lines ("hw.physicalcpu: 10"). */
export const parseSysctl = (out: string) => Object.fromEntries([...out.matchAll(/^(\w+(?:\.\w+)+): (.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));

/** `system_profiler SPDisplaysDataType -json`. */
export function parseMacDisplays(json: string): Gpu[] {
  try {
    const rows = (JSON.parse(json) as { SPDisplaysDataType?: Array<{ sppci_model?: string; _name?: string; spdisplays_vendor?: string }> }).SPDisplaysDataType ?? [];
    return rows.map((r) => {
      const model = r.sppci_model ?? r._name ?? "unknown";
      return { vendor: gpuVendor(`${r.spdisplays_vendor ?? ""} ${model}`), model };
    });
  } catch { return []; }
}

/** `pmset -g batt`: its first line names the power source. */
export const parsePmset = (out: string) => (out.includes("'Battery Power'") ? true : out.includes("'AC Power'") ? false : undefined);

/** The one PowerShell probe below: Win32_VideoController, Win32_Processor and Win32_Battery. */
export function parseWindowsProbe(json: string): Pick<DeviceProfile, "gpus" | "physicalCores" | "onBattery"> {
  try {
    const list = <T>(v: T | T[] | undefined) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
    const o = JSON.parse(json) as { gpu?: unknown; cpu?: unknown; battery?: unknown };
    const gpus = list(o.gpu as { Name?: string; AdapterCompatibility?: string; DriverVersion?: string }[])
      // The Basic Display / Remote Display adapters are software renderers.
      .filter((g) => g.Name && !/basic display|basic render|remote display/i.test(g.Name))
      .map((g) => ({ vendor: gpuVendor(`${g.AdapterCompatibility ?? ""} ${g.Name}`), model: g.Name!, driver: g.DriverVersion || undefined }));
    const cores = list(o.cpu as { NumberOfCores?: number }[]).reduce((n, c) => n + (c.NumberOfCores ?? 0), 0);
    // BatteryStatus 1 is "discharging"; a desktop has no Win32_Battery row at all.
    const batteries = list(o.battery as { BatteryStatus?: number }[]);
    return { gpus, physicalCores: cores || undefined, onBattery: batteries.length ? batteries.some((b) => b.BatteryStatus === 1) : undefined };
  } catch { return { gpus: [] }; }
}

/** `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`. */
export const parseNvidiaSmi = (out: string): Gpu[] => out.split("\n").map((l) => l.split(",").map((s) => s.trim())).filter(([name]) => name)
  .map(([model, driver]) => ({ vendor: "nvidia" as const, model: model!, driver }));

/** `lspci -mm`: display controllers, as "vendor" "device" quoted fields. */
export const parseLspci = (out: string): Gpu[] => out.split("\n").filter((l) => /"(VGA compatible|3D|Display) controller"/.test(l)).map((l) => {
  const [, vendor = "", model = ""] = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return { vendor: gpuVendor(vendor), model: `${vendor} ${model}`.trim() };
});

/** Unique (physical id, core id) pairs of /proc/cpuinfo; O(lines). */
export function physicalCoresFromCpuinfo(text: string): number | undefined {
  const cores = new Set<string>();
  let socket = "0";
  for (const line of text.split("\n")) {
    const [k, v] = line.split(":").map((s) => s.trim());
    if (k === "physical id") socket = v!;
    else if (k === "core id") cores.add(`${socket}:${v}`);
  }
  return cores.size || undefined;
}

/** /sys/class/power_supply: on battery when there is a mains supply and none is online. */
export function linuxOnBattery(supplies: Array<{ type: string; online: string }>): boolean | undefined {
  const mains = supplies.filter((s) => s.type.trim() === "Mains");
  return mains.length ? mains.every((s) => s.online.trim() === "0") : undefined;
}

// ── execution providers ──────────────────────────────────────────────────────
// Markers of a provider compiled into ONNX Runtime: the class's C++ type name
// (Itanium mangling on macOS and Linux, MSVC on Windows), or, for CUDA, its
// provider library next to the runtime. Checked 2026-09-25 against the
// sherpa-onnx 1.13.8 prebuilts: both darwin builds carry CoreML, the win and
// linux builds only the CPU provider.
const MARKERS: Array<[Provider, string[]]> = [
  ["coreml", ["23CoreMLExecutionProviderE", "CoreMLExecutionProvider@onnxruntime@@"]],
  ["directml", ["@Dml@@"]],
];

/** Providers an ONNX Runtime build carries, from its library bytes and the files beside it. O(library bytes). */
export function builtProviders(lib: Buffer | null, files: string[]): Provider[] {
  const out: Provider[] = ["cpu"];
  for (const [p, marks] of MARKERS) if (lib && marks.some((m) => lib.includes(m))) out.push(p);
  if (files.some((f) => /onnxruntime_providers_cuda/.test(f))) out.push("cuda");
  return out;
}

/** Of the built providers, the ones that can run here: CoreML on macOS, CUDA
 *  with an NVIDIA GPU, DirectML on Windows and WebGPU with any GPU. */
export const usableProviders = (built: Provider[], d: Pick<DeviceProfile, "os" | "gpus">): Provider[] => built.filter((p) =>
  p === "cpu" || (p === "coreml" && d.os === "darwin") || (p === "cuda" && d.gpus.some((g) => g.vendor === "nvidia"))
  || (p === "directml" && d.os === "win32" && d.gpus.length > 0) || (p === "webgpu" && d.gpus.length > 0));

/** onnxruntime-node's own list of the providers its binary for this platform
 *  carries ({ name, bundled }): 1.30.0 lists cpu, webgpu and coreml on macOS
 *  arm64 (checked 2026-09-25); per its install script, DirectML ships on
 *  Windows and CUDA is a separate download on Linux x64. A provider not bundled
 *  counts only once its library is next to the binary. */
export function ortBuiltProviders(backends: Array<{ name: string; bundled: boolean }>, files: string[]): Provider[] {
  const names: Record<string, Provider> = { cpu: "cpu", coreml: "coreml", cuda: "cuda", dml: "directml", webgpu: "webgpu" };
  const out = new Set<Provider>(["cpu"]);
  for (const b of backends) {
    const p = names[b.name];
    if (p && (b.bundled || files.some((f) => f.includes(`onnxruntime_providers_${b.name}`)))) out.add(p);
  }
  return [...out];
}

/** sherpa-onnx's platform package holds its ONNX Runtime; addon.js finds it the same way. */
function runtimeProbe(): { version: string; built: Provider[] } {
  try {
    const req = createRequire(import.meta.url);
    const version = (req("sherpa-onnx-node/package.json") as { version: string }).version;
    const pkg = `sherpa-onnx-${platform() === "win32" ? "win" : platform()}-${arch()}`;
    const dir = [join(dirname(req.resolve("sherpa-onnx-node/package.json")), "..", pkg), join(dirname(req.resolve("sherpa-onnx-node/package.json")), "node_modules", pkg)].find(existsSync);
    const files = dir ? readdirSync(dir) : [];
    const lib = files.find((f) => /^(lib)?onnxruntime(\.\d[\d.]*)?\.(dylib|so|dll)$/.test(f));
    return { version, built: builtProviders(dir && lib ? readFileSync(join(dir, lib)) : null, files) };
  } catch { return { version: "unknown", built: ["cpu"] }; }
}

let ort: { version: string; built: Provider[] } | null | undefined;
/** onnxruntime-node's version and built providers, or null when its binary
 *  cannot load here. Loads it once. */
export function ortProbe(): { version: string; built: Provider[] } | null {
  if (ort !== undefined) return ort;
  try {
    const req = createRequire(import.meta.url);
    const runtime = req("onnxruntime-node") as { listSupportedBackends(): Array<{ name: string; bundled: boolean }> };
    const version = (req("onnxruntime-node/package.json") as { version: string }).version;
    const binDir = join(dirname(req.resolve("onnxruntime-node/package.json")), "bin", "napi-v6", platform(), arch());
    return ort = { version, built: ortBuiltProviders(runtime.listSupportedBackends(), existsSync(binDir) ? readdirSync(binDir) : []) };
  } catch { return ort = null; }
}

// ── policy ───────────────────────────────────────────────────────────────────
/** Threads per native engine. The ASR and TTS workers run at once during a
 *  call, so each gets its share of the fast cores: half the performance cores
 *  on Apple Silicon (the E-cores are left to the UI and the model's client; an
 *  intra-op thread parked on one holds the others back), else a third of the
 *  physical cores (a hyperthread sibling adds little to matrix math). Capped at
 *  4: measured 2026-09-25 on an M4 (4P+6E), kitten nano ran slower on 4
 *  threads than on 2, and Nemotron 3.5 no faster (bench:voice --threads). */
export function threadsFor(d: Pick<DeviceProfile, "cores" | "physicalCores" | "performanceCores">): number {
  const share = d.performanceCores ? d.performanceCores / 2 : (d.physicalCores ?? Math.ceil(d.cores / 2)) / 3;
  return Math.min(4, Math.max(1, Math.floor(share)));
}

/** A coarse class for recommending engines later: low runs only the smallest
 *  models in real time, high the largest. */
export function tier(d: Pick<DeviceProfile, "cores" | "physicalCores" | "performanceCores" | "ramBytes" | "gpus" | "appleSilicon">): Tier {
  const gb = d.ramBytes / 2 ** 30;
  // An efficiency core counts as half a core.
  const cores = d.performanceCores ? d.performanceCores + ((d.physicalCores ?? d.performanceCores) - d.performanceCores) / 2 : d.physicalCores ?? d.cores / 2;
  if (gb < 7.5 || cores < 4) return "low";
  if (gb >= 15.5 && (cores >= 8 || d.appleSilicon || d.gpus.some((g) => g.vendor === "nvidia"))) return "high";
  return "mid";
}

/** Changes when anything the benchmark results depend on changes. Free RAM and
 *  the power source are left out: they move all day. */
export const fingerprint = (d: DeviceProfile) => [d.os, d.osVersion, d.arch, d.cpu, d.cores, d.physicalCores ?? "", d.performanceCores ?? "",
  Math.round(d.ramBytes / 2 ** 30), d.gpus.map((g) => `${g.model} ${g.driver ?? ""}`.trim()).join("+"), d.runtime].join("|");

// ── probing ──────────────────────────────────────────────────────────────────
/** From node:os alone: synchronous, never fails, and what every choice uses
 *  until the full probe lands. */
export function baseProfile(): DeviceProfile {
  const c = cpus();
  return {
    os: platform(), osVersion: release(), arch: arch(), cpu: c[0]?.model.trim() || "unknown", cores: availableParallelism(),
    ramBytes: totalmem(), freeRamBytes: freemem(), gpus: [], runtime: "unprobed", providers: ["cpu"],
  };
}

const WINDOWS_PROBE = "$ErrorActionPreference='SilentlyContinue';@{gpu=@(Get-CimInstance Win32_VideoController|Select-Object Name,AdapterCompatibility,DriverVersion);"
  + "cpu=@(Get-CimInstance Win32_Processor|Select-Object NumberOfCores);battery=@(Get-CimInstance Win32_Battery|Select-Object BatteryStatus)}|ConvertTo-Json -Depth 3 -Compress";

/** The full profile: the OS's own tools, each in parallel, each allowed to fail. */
export async function probeDevice(): Promise<DeviceProfile> {
  const d = baseProfile();
  const rt = runtimeProbe();
  if (d.os === "darwin") {
    const [sysctl, displays, batt, ver] = await Promise.all([
      run("sysctl", ["hw.physicalcpu", "hw.perflevel0.physicalcpu", "hw.optional.arm64"]),
      run("system_profiler", ["SPDisplaysDataType", "-json"], 8000), run("pmset", ["-g", "batt"]), run("sw_vers", ["-productVersion"]),
    ]);
    const s = parseSysctl(sysctl);
    d.appleSilicon = s["hw.optional.arm64"] === "1";
    Object.assign(d, {
      physicalCores: int(s["hw.physicalcpu"]), performanceCores: d.appleSilicon ? int(s["hw.perflevel0.physicalcpu"]) : undefined,
      gpus: parseMacDisplays(displays), onBattery: parsePmset(batt), osVersion: ver.trim() ? `macOS ${ver.trim()}` : d.osVersion,
    });
  } else if (d.os === "win32") {
    Object.assign(d, parseWindowsProbe(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE], 10_000)), { osVersion: `Windows ${d.osVersion}` });
  } else if (d.os === "linux") {
    const nvidia = parseNvidiaSmi(await run("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]));
    const others = parseLspci(await run("lspci", ["-mm"])).filter((g) => !nvidia.length || g.vendor !== "nvidia");
    let supplies: Array<{ type: string; online: string }> = [];
    try { supplies = readdirSync("/sys/class/power_supply").map((n) => ({ type: read(`/sys/class/power_supply/${n}/type`), online: read(`/sys/class/power_supply/${n}/online`) })); } catch { /* no sysfs */ }
    const distro = /^PRETTY_NAME="?([^"\n]*)/m.exec(read("/etc/os-release"))?.[1];
    Object.assign(d, {
      gpus: [...nvidia, ...others], physicalCores: physicalCoresFromCpuinfo(read("/proc/cpuinfo")), onBattery: linuxOnBattery(supplies),
      osVersion: distro ? `${distro} (${d.osVersion})` : d.osVersion,
    });
  }
  d.runtime = `sherpa-onnx ${rt.version} (${rt.built.join(", ")})`;
  d.providers = usableProviders(rt.built, d);
  const o = ortProbe();
  d.ortRuntime = o ? `onnxruntime-node ${o.version} (${o.built.join(", ")})` : "onnxruntime-node unavailable";
  d.ortProviders = o ? usableProviders(o.built, d) : [];
  return d;
}
