import assert from "node:assert";
import { test, vi } from "vitest";
import { isMirrored, listWslDistros, parseProbe, parseWslList, toWslPath, wslEnv, wslHostFor, wslLaunch } from "./wsl";

const utf16 = (s: string) => Buffer.from(`\uFEFF${s}`, "utf16le");

test("distro list decodes UTF-16LE, drops BOM, NULs, blanks and Docker's own distros", () => {
  assert.deepEqual(parseWslList(utf16("Ubuntu-24.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\n")), ["Ubuntu-24.04", "Debian"]);
  assert.deepEqual(parseWslList(Buffer.from("Ubuntu\r\n\r\nArch\r\n", "utf8")), ["Ubuntu", "Arch"]); // WSL_UTF8=1
  assert.deepEqual(parseWslList(Buffer.from("U\0b\0u\0n\0t\0u\0\n\0", "latin1")), ["Ubuntu"]);
  assert.deepEqual(parseWslList(Buffer.alloc(0)), []);
});

test("listWslDistros asks only on Windows, and a missing WSL is an empty list", async () => {
  let calls = 0;
  let env: NodeJS.ProcessEnv | undefined;
  const run = async (_f: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => { calls++; env = o.env; return { stdout: utf16("Ubuntu\r\n") }; };
  assert.deepEqual(await listWslDistros({ platform: "darwin", run }), []);
  assert.equal(calls, 0);
  assert.deepEqual(await listWslDistros({ platform: "win32", run }), ["Ubuntu"]);
  assert.equal(env?.WSL_UTF8, "1");
  assert.deepEqual(await listWslDistros({ platform: "win32", run: async () => { throw new Error("no wsl"); } }), []);
});

test("Windows paths become Linux ones", () => {
  assert.equal(toWslPath("C:\\Users\\x\\proj", "Ubuntu"), "/mnt/c/Users/x/proj");
  assert.equal(toWslPath("D:/work/app/", "Ubuntu"), "/mnt/d/work/app");
  assert.equal(toWslPath("C:\\", "Ubuntu"), "/mnt/c");
  assert.equal(toWslPath("\\\\?\\E:\\a b\\c", "Ubuntu"), "/mnt/e/a b/c");
  assert.equal(toWslPath("\\\\wsl$\\Ubuntu\\home\\x\\proj", "Ubuntu"), "/home/x/proj");
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\x", "ubuntu-24.04"), "/home/x");
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu", "Ubuntu"), "/");
  assert.equal(toWslPath("//wsl$/Ubuntu/home/x/", "Ubuntu"), "/home/x");
  assert.equal(toWslPath("//wsl.localhost/Ubuntu/home/x", "Ubuntu"), "/home/x");
  assert.equal(toWslPath("/home/x/proj", "Ubuntu"), "/home/x/proj");
});

test("a path the distro cannot open is null, never passed on as if it could", () => {
  assert.equal(toWslPath("\\\\wsl$\\Debian\\home\\x", "Ubuntu"), null);
  assert.equal(toWslPath("\\\\wsl.localhost\\Debian\\home\\x", "Ubuntu"), null);
  assert.equal(toWslPath("//wsl$/Debian/home/x", "Ubuntu"), null);
  assert.equal(toWslPath("\\\\server\\share\\proj", "Ubuntu"), null);
  assert.equal(toWslPath("\\\\?\\UNC\\server\\share", "Ubuntu"), null);
  assert.equal(toWslPath("//server/share", "Ubuntu"), null);
  assert.equal(toWslPath("proj\\sub", "Ubuntu"), null);
  assert.equal(toWslPath("", "Ubuntu"), null);
});

test("the launch sets the probed PATH and runs the command by its resolved path, with no shell between", () => {
  const host = { distro: "Ubuntu", path: "/home/x/.nvm/bin:/usr/bin", bins: { npx: "/home/x/.nvm/bin/npx" } };
  assert.deepEqual(wslLaunch(host, "npx", ["-y", "pkg@1"], "/mnt/c/Users/x/my proj"), {
    command: "wsl.exe",
    args: ["-d", "Ubuntu", "--cd", "/mnt/c/Users/x/my proj", "--exec", "env", "PATH=/home/x/.nvm/bin:/usr/bin", "/home/x/.nvm/bin/npx", "-y", "pkg@1"],
  });
  assert.equal(wslLaunch(host, "other", [], "/").args.at(-1), "other");
});

test("mirrored networking is read from [wsl2] in .wslconfig", () => {
  assert.equal(isMirrored("[wsl2]\nnetworkingMode=mirrored\n"), true);
  assert.equal(isMirrored("[wsl2]\r\nmemory=4GB\r\nNetworkingMode = Mirrored # fast\r\n"), true);
  assert.equal(isMirrored("[wsl2]\nnetworkingMode=NAT\n"), false);
  assert.equal(isMirrored("[wsl2]\n#networkingMode=mirrored\n"), false);
  assert.equal(isMirrored("[experimental]\nnetworkingMode=mirrored\n"), false);
  assert.equal(isMirrored(""), false);
});

test("WSLENV lists the variables to hand over, after any the user set", () => {
  assert.deepEqual(wslEnv([]), {});
  const was = process.env.WSLENV;
  try {
    delete process.env.WSLENV;
    assert.deepEqual(wslEnv(["A", "B"]), { WSLENV: "A:B" });
    process.env.WSLENV = "TERM/u";
    assert.deepEqual(wslEnv(["A"]), { WSLENV: "TERM/u:A" });
  } finally { if (was === undefined) delete process.env.WSLENV; else process.env.WSLENV = was; }
});

const reply = (path: string, bins: Record<string, string>) => ({
  stdout: ["Welcome banner from .bashrc", `OPENLIVE_PATH\t${path}`, ...Object.entries(bins).map(([b, p]) => `OPENLIVE_BIN\t${b}\t${p}`), ""].join("\n"),
});

test("a probe reads only its tagged lines, and drops aliases, Windows binaries and a missing PATH", () => {
  assert.deepEqual(parseProbe(reply("/a:/b", { claude: "/usr/bin/claude", npx: "/mnt/c/Program Files/nodejs/npx", ll: "alias ll='ls -l'" }).stdout), { path: "/a:/b", bins: { claude: "/usr/bin/claude" } });
  assert.equal(parseProbe("OPENLIVE_BIN\tclaude\t/usr/bin/claude\n"), null);
  assert.equal(parseProbe(""), null);
});

test("one wsl.exe call through the user's shell answers for every agent, unsafe names never reach it, and it is cached", async () => {
  const seen: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run = async (_f: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { seen.push({ args, env: opts.env }); return reply("/nvm:/usr/bin", { claude: "/nvm/claude", npx: "/nvm/npx", codex: "/nvm/codex" }); };
  const w = { platform: "win32" as const, run };
  const [a, b] = await Promise.all([
    wslHostFor("probe-a", ["claude"], "npx", () => false, w),
    wslHostFor("probe-a", ["codex"], "npx", () => false, w),
  ]);
  assert.equal(seen.length, 1);
  assert.equal(a?.path, "/nvm:/usr/bin");
  assert.equal(b?.bins.codex, "/nvm/codex");
  assert.equal(seen[0]!.env?.WSL_UTF8, "1");
  const argv = seen[0]!.args;
  assert.deepEqual(argv.slice(0, 4), ["-d", "probe-a", "--exec", "sh"]);
  assert.match(argv[5]!, /-lic/); // login and interactive, so ~/.bashrc and ~/.zshrc are read
  assert.ok(argv.includes("claude") && argv.includes("npx") && argv.includes("kiro-cli"));
  assert.equal(await wslHostFor("probe-a", ["claude"], "npx", () => false, w).then((h) => h?.distro), "probe-a");
  assert.equal(seen.length, 1);
  assert.equal(await wslHostFor("probe-a", ["x; rm -rf ~"], "npx", () => false, w), null);
  assert.ok(!seen.some((s) => s.args.includes("x; rm -rf ~")));
  await wslHostFor("probe-b", ["claude"], "npx", () => false, w); // another distro is its own entry
  assert.equal(seen.length, 2);
});

test("a bin outside the registry is probed for too", async () => {
  const seen: string[][] = [];
  const run = async (_f: string, args: string[]) => { seen.push(args); return reply("/p", { mytool: "/p/mytool", npx: "/p/npx" }); };
  assert.equal((await wslHostFor("probe-custom", ["mytool"], "npx", () => false, { platform: "win32", run }))?.bins.mytool, "/p/mytool");
  assert.ok(seen[0]!.includes("mytool"));
});

test("a failed or timed-out probe is not remembered, and a stale answer is served while a refresh runs", async () => {
  let calls = 0;
  let fail = true;
  const run = async () => { calls++; if (fail) throw new Error("timed out"); return reply("/p", { claude: "/p/claude", npx: "/p/npx" }); };
  const w = { platform: "win32" as const, run };
  assert.equal(await wslHostFor("probe-flaky", ["claude"], "npx", () => false, w), null);
  fail = false;
  assert.equal((await wslHostFor("probe-flaky", ["claude"], "npx", () => false, w))?.path, "/p"); // asked again, not "absent for a minute"
  assert.equal(calls, 2);

  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  try {
    fail = true;
    assert.equal((await wslHostFor("probe-flaky", ["claude"], "npx", () => false, w))?.path, "/p"); // stale, served at once
    await vi.waitFor(() => assert.equal(calls, 3)); // the refresh ran in the background
    assert.equal((await wslHostFor("probe-flaky", ["claude"], "npx", () => false, w))?.path, "/p"); // and failing left the last good answer
  } finally { clock.mockRestore(); }
});

test("a login shell that never reports its PATH is not a definitive answer", async () => {
  const run = async () => ({ stdout: "OPENLIVE_BIN\tclaude\t/usr/bin/claude\n" });
  assert.equal(await wslHostFor("probe-mute", ["claude"], "npx", () => false, { platform: "win32", run }), null);
});

const hits = (...have: string[]) => ({ run: async () => reply("/p", Object.fromEntries(have.map((b) => [b, `/p/${b}`]))) });

test("a miss on the Windows PATH that hits in WSL runs the agent there", async () => {
  const host = await wslHostFor("host-1", ["claude"], "npx", () => false, { platform: "win32", ...hits("claude", "npx") });
  assert.deepEqual(host, { distro: "host-1", path: "/p", bins: { claude: "/p/claude", npx: "/p/npx" } });
});

test("a CLI on the Windows PATH stays on Windows, with no WSL probe", async () => {
  let calls = 0;
  const run = async () => { calls++; return reply("/p", {}); };
  assert.equal(await wslHostFor("host-2", ["claude"], "npx", () => true, { platform: "win32", run }), null);
  assert.equal(calls, 0);
});

test("setting off, or not Windows, never probes WSL", async () => {
  let calls = 0;
  const run = async () => { calls++; return reply("/p", { claude: "/p/claude", npx: "/p/npx" }); };
  assert.equal(await wslHostFor("", ["claude"], "npx", () => false, { platform: "win32", run }), null);
  assert.equal(await wslHostFor(undefined, ["claude"], "npx", () => false, { platform: "win32", run }), null);
  assert.equal(await wslHostFor("host-3", ["claude"], "npx", () => false, { platform: "darwin", run }), null);
  assert.equal(await wslHostFor("host-3", ["claude"], "npx", () => false, { platform: "linux", run }), null);
  assert.equal(calls, 0);
});

test("the distro needs the adapter command and one of the CLIs, else it is not a host", async () => {
  assert.equal(await wslHostFor("host-4", ["claude"], "npx", () => false, { platform: "win32", ...hits("claude") }), null);
  assert.equal(await wslHostFor("host-5", ["claude"], "npx", () => false, { platform: "win32", ...hits("npx") }), null);
  assert.equal((await wslHostFor("host-6", ["agent", "cursor-agent"], "agent", () => false, { platform: "win32", ...hits("cursor-agent", "agent") }))?.distro, "host-6");
});

test("a Windows node and npx that WSL reaches through /mnt/ do not count as the distro's own", async () => {
  const run = async () => reply("/p", { claude: "/p/claude", npx: "/mnt/c/Program Files/nodejs/npx" });
  assert.equal(await wslHostFor("host-7", ["claude"], "npx", () => false, { platform: "win32", run }), null);
});
