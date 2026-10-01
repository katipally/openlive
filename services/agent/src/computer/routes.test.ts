import { describe, expect, it } from "vitest";
import { computerRoutes } from "./routes.js";

const grants = [{ id: "accessibility", granted: false, settingsUrl: "x-apple.systempreferences:a" }];
const helper = (available: boolean) => {
  const calls: Array<[string, unknown]> = [];
  return { calls, port: { available: () => available, call: async <T>(m: string, p?: unknown) => { calls.push([m, p]); return { grants } as T; } } };
};

describe("/computer", () => {
  it("says there is nothing to grant where there is no helper, without starting one", async () => {
    const h = helper(false);
    const res = await computerRoutes(h.port).request("/permissions");
    expect(await res.json()).toEqual({ available: false, grants: [] });
    expect(h.calls).toEqual([]);
  });

  it("reads the helper's grants, and asks for one only by name", async () => {
    const h = helper(true);
    const routes = computerRoutes(h.port);
    expect(await (await routes.request("/permissions")).json()).toEqual({ available: true, grants });
    expect((await routes.request("/permissions/request", { method: "POST", body: JSON.stringify({ id: "camera" }) })).status).toBe(400);
    expect((await routes.request("/permissions/request", { method: "POST", body: JSON.stringify({ id: "accessibility" }) })).status).toBe(200);
    expect(h.calls).toEqual([["permissions", undefined], ["requestPermission", { id: "accessibility" }]]);
  });
});
