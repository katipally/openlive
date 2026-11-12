// Coding agents installed inside a WSL2 distro, for the Windows build. Opt-in: the
// `wslDistro` setting names the distro (empty is off), and nothing here runs on
// another platform or while it is empty.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Run = (file: string, args: string[], opts: { timeout: number; windowsHide: true; encoding?: "buffer" }) => Promise<{ stdout: string | Buffer }>;
interface Deps { platform?: NodeJS.Platform; run?: Run }

const run: Run = promisify(execFile) as unknown as Run;

/** Distro names out of `wsl.exe -l -q`. It writes UTF-16LE (UTF-8 when WSL_UTF8 is set), and a BOM on some builds. */
export function parseWslList(out: Buffer | string): string[] {
  const text = typeof out === "string" ? out : out.includes(0) ? out.toString("utf16le") : out.toString("utf8");
  return text.replace(/[\uFEFF\0]/g, "").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("docker-desktop")); // Docker's own backing distros, never a place to run an agent
}

export async function listWslDistros({ platform = process.platform, run: exec = run }: Deps = {}): Promise<string[]> {
  if (platform !== "win32") return [];
  try { return parseWslList((await exec("wsl.exe", ["-l", "-q"], { timeout: 5000, windowsHide: true, encoding: "buffer" })).stdout); }
  catch { return []; } // WSL not installed, or no distro in it
}

/** The Linux path for a Windows one: `C:\Users\x` is `/mnt/c/Users/x`, and a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` share is the distro's own `/…`. A path that is already Linux's passes through. */
export function toWslPath(p: string): string {
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(p);
  if (unc) return (unc[1] ?? "").replace(/\\/g, "/") || "/";
  const drive = /^(?:\\\\\?\\)?([a-z]):(?:[\\/](.*))?$/i.exec(p);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${drive[2] ? `/${drive[2].replace(/\\/g, "/").replace(/\/+$/, "")}` : ""}`;
  return p;
}

/** `wsl.exe` argv that runs `command` in `distro` from `cwd` (Windows or Linux path), through the distro's login shell so its profile's PATH (npm globals, version managers) applies. --exec skips wsl's own shell, so no argument is re-parsed. */
export function wslLaunch(distro: string, command: string, args: string[], cwd: string): { command: "wsl.exe"; args: string[] } {
  return { command: "wsl.exe", args: ["-d", distro, "--cd", toWslPath(cwd), "--exec", "sh", "-lc", 'exec "$0" "$@"', command, ...args] };
}

/** WSLENV, which names the Windows environment variables wsl.exe hands to the Linux process; without it none of ours cross over. */
export function wslEnv(names: string[]): { WSLENV?: string } {
  return names.length ? { WSLENV: [process.env.WSLENV, ...names].filter(Boolean).join(":") } : {};
}

const SAFE_BIN = /^[\w@.+-]+$/;
const TTL_MS = 60_000; // short, so an install in the distro shows up without restarting
const probed = new Map<string, { at: number; found: Promise<boolean> }>();

/** Whether `bin` resolves in `distro`'s login shell. Cached per (distro, bin); a wsl.exe call can cold-start the WSL VM. */
export function inWsl(distro: string, bin: string, exec: Run = run): Promise<boolean> {
  if (!SAFE_BIN.test(bin)) return Promise.resolve(false); // spliced into a shell command below
  const key = `${distro}\0${bin}`;
  const hit = probed.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.found;
  const found = exec("wsl.exe", ["-d", distro, "--exec", "sh", "-lc", `command -v ${bin}`], { timeout: 15_000, windowsHide: true }).then(() => true, () => false);
  probed.set(key, { at: Date.now(), found });
  return found;
}

/** The distro an agent should run in: `distro` (the setting) when it is set on Windows, none of the agent's CLIs (`bins`) is on the Windows PATH, and the distro has one of them and the adapter `command`. Otherwise "", and the agent runs where it always has. */
export async function wslHostFor(distro: string | undefined, bins: string[], command: string, onWindows: (bin: string) => boolean, deps: Deps = {}): Promise<string> {
  const d = distro?.trim();
  if (!d || (deps.platform ?? process.platform) !== "win32" || bins.some(onWindows)) return "";
  const exec = deps.run ?? run;
  const [cli, adapter] = await Promise.all([Promise.all(bins.map((b) => inWsl(d, b, exec))), inWsl(d, command, exec)]);
  return adapter && cli.some(Boolean) ? d : "";
}
