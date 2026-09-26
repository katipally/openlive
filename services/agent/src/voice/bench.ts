import { parseArgs } from "node:util";
import { probeDevice, threadsFor, tier, type Provider } from "./device.js";
import { chooseProvider, providersFor } from "./accel.js";
import { NATIVE_ENGINES, engineInstalled } from "./native-models.js";
import { benchEngine } from "./native.js";

// Developer tool: times every installed native engine on each execution
// provider this device has, the same benchmark the agent runs on each user's
// machine (accel.ts), and prints it. Writes nothing; the app never reads these.
//   pnpm --filter @openlive/agent bench:voice [--engine id,id] [--providers cpu,coreml] [--threads 1,2,4]
// OPENLIVE_DATA_DIR points it at another data dir's models.

const { values } = parseArgs({ options: { engine: { type: "string" }, providers: { type: "string" }, threads: { type: "string" } } });
const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const device = await probeDevice();
const asked = list(values.providers) as Provider[] | undefined;
const threads = list(values.threads)?.map(Number) ?? [threadsFor(device)];
const engines = NATIVE_ENGINES.filter((e) => engineInstalled(e) && (!values.engine || list(values.engine)!.includes(e.id)));

console.log(`${device.cpu} · ${device.os} ${device.arch} · ${device.osVersion} · ${device.cores} logical / ${device.physicalCores ?? "?"} physical / ${device.performanceCores ?? "-"} performance cores`);
console.log(`${Math.round(device.ramBytes / 2 ** 30)} GB RAM · GPU ${device.gpus.map((g) => g.model).join(", ") || "none found"} · ${device.runtime} · ${device.ortRuntime} · tier ${tier(device)} · ${threadsFor(device)} threads by default\n`);
if (!engines.length) console.log("No native engines installed in this data dir.");

const pad = (s: unknown, n: number) => String(s).padStart(n);
console.log(`${"engine".padEnd(28)}${pad("provider", 9)}${pad("threads", 8)}${pad("load ms", 9)}${pad("warm ms", 9)}${pad("first ms", 10)}${pad("rtf", 8)}`);
for (const e of engines) {
  const providers = asked ?? providersFor(e, device);
  for (const t of threads) {
    const results = await benchEngine(e, providers, t);
    for (const r of results) {
      const row = "rtf" in r ? [pad(r.loadMs, 9), pad(r.warmMs, 9), pad(r.firstMs, 10), pad(r.rtf, 8)].join("") : `  error: ${r.error}`;
      console.log(`${e.id.padEnd(28)}${pad(r.provider, 9)}${pad(t, 8)}${row}`);
    }
    if (providers.length > 1) console.log(`${"".padEnd(28)}${pad(`-> ${chooseProvider(results)}`, 9)}`);
  }
}
process.exit(0); // the idle native workers would otherwise keep the process alive
