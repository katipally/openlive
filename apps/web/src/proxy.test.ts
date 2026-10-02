import { describe, expect, it } from "vitest";
import { proxy, refusal } from "./proxy";

const APP = "http://localhost:47824";
const req = (method: string, h: Record<string, string>) => ({ method, headers: new Headers({ host: "localhost:47824", ...h }) });
const json = { "content-type": "application/json", "content-length": "2" };

describe("the /api proxy", () => {
  it("refuses a cross-site text/plain POST, the one a page on any site can send unasked", () => {
    expect(refusal(req("POST", { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain", "content-length": "2" }))?.status).toBe(403);
    // Without fetch metadata (an older browser), the Origin alone refuses it.
    expect(refusal(req("POST", { origin: "https://evil.example", ...json }))?.status).toBe(403);
    expect(refusal(req("POST", { referer: "https://evil.example/page", ...json }))?.status).toBe(403);
    expect(refusal(req("POST", { origin: "null", ...json }))?.status).toBe(403);
  });

  it("refuses another server on this machine, and a page that rebinds its DNS here", () => {
    expect(refusal(req("POST", { origin: "http://localhost:3001", "sec-fetch-site": "same-site", ...json }))?.status).toBe(403);
    expect(refusal(req("GET", { host: "evil.example:47824" }))?.status).toBe(403);
    expect(refusal(req("POST", { host: "evil.example:47824", origin: "http://evil.example:47824", "sec-fetch-site": "same-origin", ...json }))?.status).toBe(403);
  });

  it("lets the app's own JSON writes and every read through", () => {
    expect(refusal(req("POST", { origin: APP, "sec-fetch-site": "same-origin", ...json }))).toBeNull();
    expect(refusal(req("PUT", { origin: "http://127.0.0.1:47824", host: "127.0.0.1:47824", ...json }))).toBeNull();
    expect(refusal(req("POST", { origin: APP, "content-type": "application/octet-stream", "content-length": "6400" }))).toBeNull();
    expect(refusal(req("POST", { origin: APP, "content-length": "0" }))).toBeNull(); // a download, no body
    expect(refusal(req("DELETE", { origin: APP }))).toBeNull();
    expect(refusal(req("GET", { "sec-fetch-site": "cross-site" }))).toBeNull(); // CORS keeps the answer from the page
  });

  it("wants a typed body even from the app itself", () => {
    expect(refusal(req("POST", { origin: APP, "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8", "content-length": "2" }))?.status).toBe(415);
    expect(refusal(req("POST", { origin: APP, "transfer-encoding": "chunked" }))?.status).toBe(415);
  });

  it("lets a caller that is no browser through: Electron main, scripts, tests", () => {
    expect(refusal(req("PUT", json))).toBeNull();
    expect(refusal(req("PUT", { "content-type": "text/plain", "content-length": "2" }))?.status).toBe(415);
  });

  it("answers a refusal in the shape every /api error has", async () => {
    const res = proxy(new Request(`${APP}/api/dictate/rewrite`, { method: "POST", headers: { host: "localhost:47824", origin: "https://evil.example" } }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "This request did not come from OpenLive." });
    expect(proxy(new Request(`${APP}/api/history`, { headers: { host: "localhost:47824" } }))).toBeUndefined();
  });
});
