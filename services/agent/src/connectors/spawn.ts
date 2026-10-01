import { expandHome, widenedPath } from "@openlive/shared/node";

// How a stdio connector is started on each OS.
//
// The SDK's stdio transport spawns through cross-spawn with shell:false, which
// is what runs a Windows .cmd/.bat shim (npx, uvx, npm) at all since Node
// refuses to spawn one without a shell (CVE-2024-27980). cross-spawn resolves
// the command against the PATH in the env it is handed, so the PATH here has to
// be the user's real one: a GUI launch gets a skeletal PATH on macOS and Linux,
// and widenedPath() adds the login shell's, the same as the coding agents get.

export interface StdioParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/**
 * The spawn for one connector: its command and folder with `~` expanded, its
 * env over the SDK's safe inherited set, and a PATH that finds what the user's
 * shell finds. A PATH the user set wins over the widened one. On Windows the
 * variable may be spelled `Path`; cross-spawn reads `PATH`, so it is folded in.
 */
export function stdioParams(
  t: { command: string; args: string[]; cwd?: string; env: Record<string, string> },
  secrets: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  path: () => string = widenedPath,
): StdioParams {
  const env = { ...t.env, ...secrets };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const own = pathKey ? env[pathKey] : undefined;
  if (pathKey) delete env[pathKey];
  const sep = platform === "win32" ? ";" : ":";
  env.PATH = own ? `${own}${sep}${path()}` : path();
  return {
    command: expandHome(t.command),
    args: t.args,
    env,
    ...(t.cwd && { cwd: expandHome(t.cwd) }),
  };
}
