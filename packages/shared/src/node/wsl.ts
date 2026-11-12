// Coding agents installed inside a WSL2 distro, for the Windows build. Opt-in: the
// `wslDistro` setting names the distro (empty is off), and nothing here runs on
// another platform or while it is empty.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_LIST } from "../agent-registry";

type Run = (file: string, args: string[], opts: { timeout: number; windowsHide: true; encoding?: "buffer"; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string | Buffer }>;
interface Deps { platform?: NodeJS.Platform; run?: Run }

const run: Run = promisify(execFile) as unknown as Run;

/** wsl.exe's own text (distro list, errors) is UTF-16LE unless this is set. */
export const WSL_UTF8 = { WSL_UTF8: "1" };

/** Distro names out of `wsl.exe -l -q`: UTF-8 under WSL_UTF8, else UTF-16LE (with a BOM on some builds). */
export function parseWslList(out: Buffer | string): string[] {
  const text = typeof out === "string" ? out : out.includes(0) ? out.toString("utf16le") : out.toString("utf8");
  return text.replace(/[\uFEFF\0]/g, "").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("docker-desktop")); // Docker's own backing distros, never a place to run an agent
}

export async function listWslDistros({ platform = process.platform, run: exec = run }: Deps = {}): Promise<string[]> {
  if (platform !== "win32") return [];
  try { return parseWslList((await exec("wsl.exe", ["-l", "-q"], { timeout: 5000, windowsHide: true, encoding: "buffer", env: { ...process.env, ...WSL_UTF8 } })).stdout); }
  catch { return []; } // WSL not installed, or no distro in it
}

/** The Linux path for a Windows one: `C:\Users\x` is `/mnt/c/Users/x` (wsl's default automount root), and a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` share is that distro's own `/…`. A Linux absolute path passes through. Null when `distro` cannot open it: a share of another distro, another server's share, or a relative path. */
export function toWslPath(p: string, distro: string): string | null {
  const s = p.startsWith("//") ? p.replace(/\//g, "\\") : p;
  const unc = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i.exec(s);
  if (unc) return unc[1]!.toLowerCase() === distro.toLowerCase() ? (unc[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "") || "/" : null;
  const drive = /^(?:\\\\\?\\)?([a-z]):(?:[\\/](.*))?$/i.exec(s);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${drive[2] ? `/${drive[2].replace(/\\/g, "/").replace(/\/+$/, "")}` : ""}`;
  return p.startsWith("/") && !p.startsWith("//") ? p : null;
}

/** A distro that can run an agent: its user's PATH as their own shell builds it (version managers included), and where each CLI and adapter command resolved. */
export interface WslHost { distro: string; path: string; bins: Record<string, string> }

/** `wsl.exe` argv that runs `command` in the host from the Linux folder `cwd`. The PATH the probe saw is set outright and the command is its resolved path, so no shell, and no rc file that prints to stdout, sits between us and the ACP stream; --exec keeps wsl.exe from re-parsing the arguments. */
export function wslLaunch(host: WslHost, command: string, args: string[], cwd: string): { command: "wsl.exe"; args: string[] } {
  return { command: "wsl.exe", args: ["-d", host.distro, "--cd", cwd, "--exec", "env", `PATH=${host.path}`, host.bins[command] ?? command, ...args] };
}

/** WSLENV, which names the Windows environment variables wsl.exe hands to the Linux process; without it none of ours cross over. */
export function wslEnv(names: string[]): { WSLENV?: string } {
  return names.length ? { WSLENV: [process.env.WSLENV, ...names].filter(Boolean).join(":") } : {};
}

/** Whether `.wslconfig` turns on mirrored networking, where the distro shares Windows' 127.0.0.1 (the default NAT mode does not). */
export function isMirrored(config: string): boolean {
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) section = head[1]!.trim().toLowerCase();
    else if (section === "wsl2" && /^networkingMode\s*=\s*mirrored$/i.test(line)) return true;
  }
  return false;
}

export function wslMirrored(): boolean {
  try { return isMirrored(readFileSync(join(homedir(), ".wslconfig"), "utf8")); } catch { return false; }
}

const SAFE_BIN = /^[\w@.+][\w@.+-]*$/;
const TTL_MS = 60_000; // short, so an install in the distro shows up without restarting
const PROBE_MS = 15_000; // a cold WSL VM can take most of this

// Names every agent could need, so one probe answers for all of them.
const KNOWN = [...new Set(AGENT_LIST.flatMap((a) => [...a.bins, a.adapter.command]))];

/** Runs in the user's own shell, interactive and login, so what ~/.bashrc and ~/.zshrc set up (nvm, fnm, volta) is on the PATH it reports. An rc file may print anything, so the answer is tagged lines, and stdin is closed so a prompt in it cannot hang. Fish and the like get sh, since the script is POSIX. */
const OUTER = 's=${SHELL:-$(getent passwd "$(id -u)" | cut -d: -f7)}; case ${s##*/} in bash|zsh|dash|sh) ;; *) s=sh;; esac; exec "$s" -lic "$@" </dev/null';
const INNER = "printf 'OPENLIVE_PATH\\t%s\\n' \"$PATH\"; for b in \"$@\"; do p=$(command -v \"$b\") && printf 'OPENLIVE_BIN\\t%s\\t%s\\n' \"$b\" \"$p\"; done; :";

interface Probe { at: number; checked: Set<string>; path: string; bins: Record<string, string> }
const probes = new Map<string, { good?: Probe; inflight?: Promise<void> }>();

/** Tagged lines to a probe; null when the shell never reported its PATH, so the answer is not a definitive one. */
export function parseProbe(out: string): { path: string; bins: Record<string, string> } | null {
  let path: string | undefined;
  const bins: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const [tag, a, b] = line.split("\t");
    if (tag === "OPENLIVE_PATH" && a) path = a;
    // Only a real file counts: an alias or function prints as text, and /mnt/ is Windows' own node and npx through appendWindowsPath.
    else if (tag === "OPENLIVE_BIN" && a && b?.startsWith("/") && !b.startsWith("/mnt/")) bins[a] = b;
  }
  return path ? { path, bins } : null;
}

function refresh(distro: string, e: NonNullable<ReturnType<typeof probes.get>>, bins: string[], exec: Run): Promise<void> {
  e.inflight ??= (async () => {
    const want = [...new Set([...KNOWN, ...(e.good?.checked ?? []), ...bins])];
    try {
      const { stdout } = await exec("wsl.exe", ["-d", distro, "--exec", "sh", "-c", OUTER, "sh", INNER, "sh", ...want], { timeout: PROBE_MS, windowsHide: true, env: { ...process.env, ...WSL_UTF8 } });
      const found = parseProbe(stdout.toString());
      if (found) e.good = { at: Date.now(), checked: new Set(want), ...found };
    } catch { /* a timeout or a cold VM says nothing about the distro, so it is not remembered */ }
    finally { e.inflight = undefined; }
  })();
  return e.inflight;
}

/** What `distro` resolves for `bins`, from the last definitive probe: one wsl.exe call for every agent at once. A stale one is served while a fresh one runs, and a failed probe leaves the last good answer standing. Null when nothing is known. */
async function probeWsl(distro: string, wanted: string[], exec: Run): Promise<Probe | null> {
  let e = probes.get(distro);
  if (!e) probes.set(distro, e = {});
  const bins = wanted.filter((b) => SAFE_BIN.test(b));
  const covers = () => e.good && bins.every((b) => e.good!.checked.has(b)) ? e.good : null;
  if (!covers()) {
    await refresh(distro, e, bins, exec);
    // The probe awaited may be one another agent started, without this one's bins.
    if (!covers() && e.good) await refresh(distro, e, bins, exec);
  }
  const good = covers();
  if (good && Date.now() - good.at >= TTL_MS) void refresh(distro, e, bins, exec);
  return good;
}

/** The distro an agent should run in: `distro` (the setting) when it is set on Windows, none of the agent's CLIs (`bins`) is on the Windows PATH, and the distro has one of them and the adapter `command`. Otherwise null, and the agent runs where it always has. */
export async function wslHostFor(distro: string | undefined, bins: string[], command: string, onWindows: (bin: string) => boolean, deps: Deps = {}): Promise<WslHost | null> {
  const d = distro?.trim();
  if (!d || (deps.platform ?? process.platform) !== "win32" || bins.some(onWindows)) return null;
  const probe = await probeWsl(d, [...bins, command], deps.run ?? run);
  return probe?.bins[command] && bins.some((b) => probe.bins[b]) ? { distro: d, path: probe.path, bins: probe.bins } : null;
}
