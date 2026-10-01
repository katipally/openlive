import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const { electronPost, httpsPost } = createRequire(import.meta.url)("./transport.cjs");

const req = { url: "https://ingest.example.test/api/track", headers: { "content-type": "application/json", origin: "https://app.example.test" }, body: '{"type":"track"}' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// A stand-in for Electron's ClientRequest and IncomingMessage: an emitter that records what was set.
function fakeNet(reply?: (r: any, res: any) => void | false) {
  const made: any[] = [];
  const net = {
    request: vi.fn((opts: any) => {
      const r: any = new EventEmitter();
      r.opts = opts;
      r.written = [];
      r.write = (c: string) => r.written.push(c);
      r.abort = vi.fn(() => r.emit("abort"));
      r.end = vi.fn(() => {
        const res: any = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        if (reply && reply(r, res) !== false) r.emit("response", res);
      });
      made.push(r);
      return r;
    }),
  };
  return { net, made };
}

const never = vi.fn(async () => ({ status: 599 }));

describe("electronPost", () => {
  it("posts the body with the headers, without cookies or redirects, and reads only the status", async () => {
    const { net, made } = fakeNet((_, res) => {
      res.statusCode = 429;
      res.headers = { "retry-after": ["30", "60"] };
    });
    const out = await electronPost(net, never)(req);
    expect(out).toEqual({ status: 429, retryAfter: "30" });
    expect(net.request).toHaveBeenCalledWith({ method: "POST", url: req.url, headers: req.headers, credentials: "omit", redirect: "error" });
    expect(made[0].written).toEqual([req.body]);
    expect(made[0].end).toHaveBeenCalledOnce();
  });

  it("resolves on the response head, before any body arrives", async () => {
    const { net } = fakeNet((_, res) => res.on("data", () => {}));
    expect((await electronPost(net, never)(req)).status).toBe(200);
  });

  it("rejects on a network error, once", async () => {
    const { net } = fakeNet((r) => {
      setTimeout(() => r.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED")), 10);
      return false;
    });
    const p = electronPost(net, never)(req);
    const seen = expect(p).rejects.toThrow("ERR_INTERNET_DISCONNECTED");
    await vi.advanceTimersByTimeAsync(20);
    await seen;
  });

  it("aborts and rejects when nothing answers in time", async () => {
    const { net, made } = fakeNet();
    const p = electronPost(net, never, 5_000)(req);
    const seen = expect(p).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await seen;
    expect(made[0].abort).toHaveBeenCalled();
  });

  it("hands one request to the fallback when Electron will not start it, and to nothing else", async () => {
    const net = { request: vi.fn(() => { throw new TypeError("net.request is unavailable"); }) };
    const fallback = vi.fn(async () => ({ status: 202, retryAfter: "7" }));
    const post = electronPost(net, fallback);
    expect(await post(req)).toEqual({ status: 202, retryAfter: "7" });
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(req);
    expect(net.request).toHaveBeenCalledOnce();
    await post(req);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(net.request).toHaveBeenCalledTimes(2);
  });

  it("passes on the fallback's own failure, without trying again", async () => {
    const net = { request: vi.fn(() => { throw new Error("bad options"); }) };
    const fallback = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(electronPost(net, fallback)(req)).rejects.toThrow("ECONNREFUSED");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not use the fallback for a network error or a bad status", async () => {
    const { net } = fakeNet((r) => {
      setTimeout(() => r.emit("error", new Error("net::ERR_FAILED")), 1);
      return false;
    });
    const fallback = vi.fn(async () => ({ status: 200 }));
    const failed = expect(electronPost(net, fallback)(req)).rejects.toThrow("ERR_FAILED");
    await vi.advanceTimersByTimeAsync(5);
    await failed;
    const { net: net401 } = fakeNet((_, res) => { res.statusCode = 401; });
    expect((await electronPost(net401, fallback)(req)).status).toBe(401);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not time out a request that answered", async () => {
    const { net, made } = fakeNet();
    const p = electronPost(net, never, 5_000)(req);
    made[0].emit("response", Object.assign(new EventEmitter(), { statusCode: 204, headers: {} }));
    expect((await p).status).toBe(204);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(made[0].abort).not.toHaveBeenCalled();
  });
});

describe("httpsPost", () => {
  function fakeHttps(status = 200, headers: Record<string, string> = {}, fault?: Error) {
    const calls: any[] = [];
    const https = {
      request: vi.fn((url: string, opts: any, cb: (res: any) => void) => {
        const r: any = new EventEmitter();
        r.body = "";
        r.destroy = vi.fn((e: Error) => r.emit("error", e));
        r.end = (b: string) => {
          r.body = b;
          if (fault) setTimeout(() => r.emit("error", fault), 1);
          else if (status) cb(Object.assign(new EventEmitter(), { statusCode: status, headers, resume: vi.fn() }));
        };
        calls.push({ url, opts, r });
        return r;
      }),
    };
    return { https, calls };
  }

  it("posts with the headers and an exact content length", async () => {
    const { https, calls } = fakeHttps(202, { "retry-after": "5" });
    const out = await httpsPost(https)({ ...req, body: '{"n":"é"}' });
    expect(out).toEqual({ status: 202, retryAfter: "5" });
    expect(calls[0].url).toBe(req.url);
    expect(calls[0].opts).toMatchObject({ method: "POST", headers: { ...req.headers, "content-length": Buffer.byteLength('{"n":"é"}') } });
    expect(calls[0].r.body).toBe('{"n":"é"}');
  });

  it("rejects on a network error", async () => {
    const { https } = fakeHttps(0, {}, new Error("ECONNREFUSED"));
    const p = httpsPost(https)(req);
    const seen = expect(p).rejects.toThrow("ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(5);
    await seen;
  });

  it("rejects on a redirect, as Electron's net does, so the sender retries instead of dropping the event", async () => {
    for (const status of [301, 302, 307, 399]) {
      const { https } = fakeHttps(status, { location: "https://portal.example.test/login" });
      await expect(httpsPost(https)(req)).rejects.toThrow("redirect");
    }
    const { https } = fakeHttps(400);
    await expect(httpsPost(https)(req)).resolves.toMatchObject({ status: 400 });
  });

  it("destroys the request on a socket timeout", async () => {
    const { https, calls } = fakeHttps(0);
    const p = httpsPost(https, 1000)(req);
    const seen = expect(p).rejects.toThrow("timeout");
    calls[0].r.emit("timeout");
    await seen;
    expect(calls[0].opts.timeout).toBe(1000);
  });
});
