"use strict";
// The two ways to POST one JSON body. Each resolves to { status, retryAfter } once
// the response head is in, and rejects on a network fault or a timeout. The body
// of the reply is never read. Electron's `net` honors the system proxy and
// certificate store, so it goes first; node:https is the fallback for a request
// Electron will not even start.
const first = (h) => (Array.isArray(h) ? h[0] : h);

/**
 * @param net Electron's `net` module
 * @param fallback the post to use once for a request whose `net.request` throws
 */
function electronPost(net, fallback, timeoutMs = 15000) {
  return (request) =>
    new Promise((resolve, reject) => {
      const { url, headers, body } = request;
      let req;
      try {
        req = net.request({ method: "POST", url, headers, credentials: "omit", redirect: "error" });
      } catch {
        return resolve(fallback(request));
      }
      let done = false;
      const settle = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(v);
      };
      const timer = setTimeout(() => {
        settle(reject, new Error("timeout"));
        req.abort();
      }, timeoutMs);
      timer.unref?.();
      req.on("response", (res) => {
        res.on("data", () => {});
        settle(resolve, { status: res.statusCode, retryAfter: first(res.headers["retry-after"]) });
      });
      req.on("error", (e) => settle(reject, e));
      req.on("abort", () => settle(reject, new Error("aborted")));
      req.write(body);
      req.end();
    });
}

/** @param https node:https */
function httpsPost(https, timeoutMs = 15000) {
  return ({ url, headers, body }) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
        res.resume();
        // Electron's net refuses a redirect the same way: a captive portal is a fault to retry, not an answer.
        if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Error("redirect"));
        resolve({ status: res.statusCode, retryAfter: first(res.headers["retry-after"]) });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
}

module.exports = { electronPost, httpsPost };
