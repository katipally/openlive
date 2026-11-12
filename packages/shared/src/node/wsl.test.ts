import assert from "node:assert";
import { test } from "vitest";
import { inWsl, listWslDistros, parseWslList, toWslPath, wslEnv, wslHostFor, wslLaunch } from "./wsl";

const utf16 = (s: string) => Buffer.from(`\uFEFF${s}`, "utf16le");

test("distro list decodes UTF-16LE, drops BOM, NULs, blanks and Docker's own distros", () => {
  assert.deepEqual(parseWslList(utf16("Ubuntu-24.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\n")), ["Ubuntu-24.04", "Debian"]);
  assert.deepEqual(parseWslList(Buffer.from("Ubuntu\r\n\r\nArch\r\n", "utf8")), ["Ubuntu", "Arch"]); // WSL_UTF8=1
  assert.deepEqual(parseWslList(Buffer.from("U\0b\0u\0n\0t\0u\0\n\0", "latin1")), ["Ubuntu"]);
  assert.deepEqual(parseWslList(Buffer.alloc(0)), []);
});

test("listWslDistros asks only on Windows, and a missing WSL is an empty list", async () => {
  let calls = 0;
  const run = async () => { calls++; return { stdout: utf16("Ubuntu\r\n") }; };
  assert.deepEqual(await listWslDistros({ platform: "darwin", run }), []);
  assert.equal(calls, 0);
  assert.deepEqual(await listWslDistros({ platform: "win32", run }), ["Ubuntu"]);
  assert.deepEqual(await listWslDistros({ platform: "win32", run: async () => { throw new Error("no wsl"); } }), []);
});

test("Windows paths become Linux ones", () => {
  assert.equal(toWslPath("C:\\Users\\x\\proj"), "/mnt/c/Users/x/proj");
  assert.equal(toWslPath("D:/work/app/"), "/mnt/d/work/app");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
  assert.equal(toWslPath("\\\\?\\E:\\a b\\c"), "/mnt/e/a b/c");
  assert.equal(toWslPath("\\\\wsl$\\Ubuntu\\home\\x\\proj"), "/home/x/proj");
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\x"), "/home/x");
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu"), "/");
  assert.equal(toWslPath("/home/x/proj"), "/home/x/proj");
});

test("the launch command runs in the distro's login shell with the translated folder", () => {
  assert.deepEqual(wslLaunch("Ubuntu", "npx", ["-y", "pkg@1"], "C:\\Users\\x\\my proj"), {
    command: "wsl.exe",
    args: ["-d", "Ubuntu", "--cd", "/mnt/c/Users/x/my proj", "--exec", "sh", "-lc", 'exec "$0" "$@"', "npx", "-y", "pkg@1"],
  });
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

test("a bin is probed once per distro through the login shell, and unsafe names never reach it", async () => {
  const seen: string[][] = [];
  const run = async (_f: string, args: string[]) => { seen.push(args); if (args.at(-1) === "command -v nope") throw new Error("exit 1"); return { stdout: "/usr/bin/x" }; };
  assert.equal(await inWsl("probe-a", "claude", run), true);
  assert.equal(await inWsl("probe-a", "claude", run), true);
  assert.equal(await inWsl("probe-a", "nope", run), false);
  assert.equal(await inWsl("probe-a", "x; rm -rf ~", run), false);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], ["-d", "probe-a", "--exec", "sh", "-lc", "command -v claude"]);
  assert.equal(await inWsl("probe-b", "claude", run), true); // another distro is its own entry
  assert.equal(seen.length, 3);
});

const present = (...have: string[]) => {
  const probes: string[] = [];
  return { probes, run: async (_f: string, args: string[]) => { const bin = args.at(-1)!.replace("command -v ", ""); probes.push(bin); if (!have.includes(bin)) throw new Error("exit 1"); return { stdout: "" }; } };
};

test("a miss on the Windows PATH that hits in WSL runs the agent there", async () => {
  const { run, probes } = present("claude", "npx");
  assert.equal(await wslHostFor("host-1", ["claude"], "npx", () => false, { platform: "win32", run }), "host-1");
  assert.deepEqual(probes.sort(), ["claude", "npx"]);
});

test("a CLI on the Windows PATH stays on Windows, with no WSL probe", async () => {
  const { run, probes } = present("claude", "npx");
  assert.equal(await wslHostFor("host-2", ["claude"], "npx", () => true, { platform: "win32", run }), "");
  assert.equal(probes.length, 0);
});

test("setting off, or not Windows, never probes WSL", async () => {
  const { run, probes } = present("claude", "npx");
  assert.equal(await wslHostFor("", ["claude"], "npx", () => false, { platform: "win32", run }), "");
  assert.equal(await wslHostFor(undefined, ["claude"], "npx", () => false, { platform: "win32", run }), "");
  assert.equal(await wslHostFor("host-3", ["claude"], "npx", () => false, { platform: "darwin", run }), "");
  assert.equal(await wslHostFor("host-3", ["claude"], "npx", () => false, { platform: "linux", run }), "");
  assert.equal(probes.length, 0);
});

test("the distro needs the adapter command and one of the CLIs, else it is not a host", async () => {
  assert.equal(await wslHostFor("host-4", ["claude"], "npx", () => false, { platform: "win32", run: present("claude").run }), "");
  assert.equal(await wslHostFor("host-5", ["claude"], "npx", () => false, { platform: "win32", run: present("npx").run }), "");
  assert.equal(await wslHostFor("host-6", ["agent", "cursor-agent"], "agent", () => false, { platform: "win32", run: present("cursor-agent", "agent").run }), "host-6");
});
