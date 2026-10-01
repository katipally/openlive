import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ComputerHelper, HelperError, locateHelper, type Grant, type Handshake, type Launch } from "./helper.js";

const FAKE = fileURLToPath(new URL("./fake-helper.mjs", import.meta.url));
const launch = (env: Record<string, string> = {}): Launch => ({ command: process.execPath, args: [FAKE], env });
const started: ComputerHelper[] = [];
const helper = (env: Record<string, string> = {}, opts: { requestTimeoutMs?: number } = {}) => {
  const h = new ComputerHelper({ locate: () => launch(env), ...opts });
  started.push(h);
  return h;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return;
  throw new Error("timed out waiting");
};

afterEach(() => { for (const h of started.splice(0)) h.shutdown(); });

describe("the helper client", () => {
  it("starts the helper on first use and speaks NDJSON to it over the local socket", async () => {
    const h = helper();
    const hello = await h.call<Handshake>("handshake");
    expect(hello.protocol).toBe(1);
    const { grants } = await h.call<{ grants: Grant[] }>("permissions");
    expect(grants.map((g) => [g.id, g.granted])).toEqual([["accessibility", true], ["screenRecording", false]]);
    // One process serves every call.
    expect((await h.call<Handshake>("handshake")).pid).toBe(hello.pid);
  });

  it("turns a refusal into an error with the helper's code", async () => {
    const err = await helper().call("explode").catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect(err.code).toBe("unknown_method");
  });

  it("restarts after a crash, failing only the call that was in flight", async () => {
    const h = helper({ FAKE_CU_CRASH_ON: "listWindows" });
    const first = (await h.call<Handshake>("handshake")).pid;
    await expect(h.call("listWindows")).rejects.toMatchObject({ code: "helper_stopped" });
    const second = (await h.call<Handshake>("handshake")).pid;
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
  });

  it("kills a helper that stops answering, and starts a fresh one", async () => {
    const h = helper({ FAKE_CU_DELAY_MS: "5000" }, { requestTimeoutMs: 200 });
    const pid = (await h.call<Handshake>("handshake")).pid;
    await expect(h.call("click", { elementIndex: 1 })).rejects.toMatchObject({ code: "action_timeout" });
    await until(() => !alive(pid));
    expect((await h.call<Handshake>("handshake")).pid).not.toBe(pid);
  });

  it("reaps the helper on shutdown", async () => {
    const h = helper();
    const pid = (await h.call<Handshake>("handshake")).pid;
    h.shutdown();
    await until(() => !alive(pid));
  });

  it("stops offering itself where its backend is a stub", async () => {
    const h = helper({ FAKE_CU_READY: "0" });
    expect(h.available()).toBe(true);
    await expect(h.call("listApps")).rejects.toMatchObject({ code: "unsupported_platform" });
    expect(h.available()).toBe(false);
  });

  it("is not available, and says so, where there is no helper", async () => {
    const h = new ComputerHelper({ locate: () => null });
    expect(h.available()).toBe(false);
    await expect(h.call("listApps")).rejects.toMatchObject({ code: "helper_missing" });
  });

  it("rests after crashing over and over", async () => {
    const h = helper({ FAKE_CU_CRASH_ON: "listApps" });
    for (let i = 0; i < 3; i++) await expect(h.call("listApps")).rejects.toMatchObject({ code: "helper_stopped" });
    expect(h.available()).toBe(false);
    await expect(h.call("handshake")).rejects.toMatchObject({ code: "helper_unavailable" });
  });

  it("serves two callers at once without crossing their replies", async () => {
    const h = helper();
    const [apps, windows] = await Promise.all([h.call<{ apps: unknown[] }>("listApps"), h.call<{ windows: unknown[] }>("listWindows")]);
    expect(apps.apps).toHaveLength(1);
    expect(windows.windows).toHaveLength(1);
  });
});

describe("locateHelper", () => {
  it("has nothing to offer where the backend is not built yet", () => {
    expect(locateHelper({}, "win32")).toBeNull();
    expect(locateHelper({}, "linux")).toBeNull();
  });

  it("takes the packaged path from the environment, and only when it exists", () => {
    expect(locateHelper({ OPENLIVE_CU_HELPER: process.execPath }, "darwin")).toEqual({ command: process.execPath });
    expect(locateHelper({ OPENLIVE_CU_HELPER: "/nowhere/openlive-cu" }, "darwin")).toBeNull();
  });

  it("is switched off by an empty path, whatever has been built", () => {
    expect(locateHelper({ OPENLIVE_CU_HELPER: "" }, "darwin")).toBeNull();
  });
});
