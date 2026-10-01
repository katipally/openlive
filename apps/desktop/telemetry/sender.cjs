"use strict";
// Drains the disk queue to OpenPanel, one request at a time and slowly: at most
// two a second, a random head start before the first send, Retry-After honored,
// and exponential backoff with jitter on anything else that fails. An event leaves
// the queue only when the server took it, so a restart resends nothing it sent
// and loses nothing it did not. Each record is checked against the schema once
// more just before it leaves, so a queue file edited by hand sends nothing the
// app would not.
const { validateEvent, validateCommon } = require("./validate.cjs");
const { usernameOf } = require("./username.cjs");

const PACE_MS = 500;
const FIRST_FLUSH_MAX_MS = 60_000;
// Counted from the moment the notice appears, so there is time to tap "Turn off" before anything goes out.
const NOTICE_FLOOR_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const BEST_EFFORT_WAITS_MS = [0, 2_000, 5_000];

/** Seconds or an HTTP date, as a delay in ms; undefined when it is neither. */
function retryAfterMs(value, now) {
  if (value === undefined || value === null || value === "") return undefined;
  const s = Number(value);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), BACKOFF_MAX_MS) : undefined;
}

/** ok: the server took it. retry: try again later. limited: retry after the server's own delay. drop: it will never be taken. */
function classify(res) {
  const s = res.status;
  if (s >= 200 && s < 300) return "ok";
  if (s === 429) return "limited";
  return s >= 500 || s === 401 || s === 403 || s === 408 || s === 425 ? "retry" : "drop";
}

function createSender({ queue, post, config, gate, profileId, now, random, timers, sleep }) {
  const url = `${config.endpoint.replace(/\/+$/, "")}/api/track`;
  const headers = { "content-type": "application/json", "openpanel-client-id": config.clientId, origin: config.origin };
  // The install whose profile name the server has: the first body a launch sends for an install names it.
  let identified = null;
  const send = async (body) => {
    const res = await post({ url, headers, body: JSON.stringify(body) });
    if (classify(res) === "ok") identified = body.payload.profileId;
    return res;
  };
  // The server reads `__ip`, `__deviceId` and `__identify` from a track body. 127.0.0.1 is on its geo ignore list, so no
  // place is stored; an identify that rides a track is placed by that same address, where a bare identify request would
  // use the real one. Without `__deviceId` it derives a device from address and user agent, and every install on one OS
  // build would share it. It must differ from the profile ID, or the server files the profile as anonymous and shows no name.
  // The last event of an install never asks for a name: someone who has just said no does not get a named profile.
  const trackBody = (rec, id) => {
    const props = validateEvent(rec.n, rec.p);
    const at = Date.parse(rec.t);
    if (!props || !Number.isFinite(at)) return null;
    const username = usernameOf(id);
    return {
      type: "track",
      payload: {
        name: rec.n,
        profileId: id,
        properties: {
          ...validateCommon({ ...rec.p, username }),
          ...props,
          __timestamp: new Date(at).toISOString(),
          __ip: "127.0.0.1",
          __deviceId: `device-${id}`,
          ...(identified !== id && rec.n !== "telemetry_disabled" && { __identify: { profileId: id, firstName: username, properties: { username } } }),
        },
      },
    };
  };

  let timer = null;
  let busy = false;
  let started = false;
  let notBefore = 0;
  let nextAt = 0;
  let failures = 0;

  const backoff = () => {
    failures++;
    const d = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    return d / 2 + random() * (d / 2);
  };

  function schedule() {
    if (!started || timer || busy) return;
    // Clamped, so a clock set back can park the sender for at most an hour.
    timer = timers.setTimeout(pump, Math.min(BACKOFF_MAX_MS, Math.max(0, Math.max(notBefore, nextAt) - now())));
    timer.unref?.();
  }

  /** One POST: `{}` when the server is done with this body (took it, or never will), else how long to wait before trying again. */
  async function attempt(body) {
    let res;
    try {
      res = await send(body);
    } catch {
      return { wait: backoff() };
    }
    const verdict = classify(res);
    if (verdict === "ok" || verdict === "drop") return {};
    return { wait: (verdict === "limited" && retryAfterMs(res.retryAfter, now())) || backoff() };
  }

  /** Send the oldest event. Resolves to the delay before the next send, or null when there is nothing to do until kicked. */
  async function step() {
    const id = profileId();
    const item = queue.peek();
    if (!gate() || !id || !item) return null;
    const body = trackBody(item.rec, id);
    if (body) {
      const r = await attempt(body);
      if (r.wait !== undefined) return r.wait;
      failures = 0;
    }
    queue.ack(item);
    return queue.size() ? PACE_MS : null;
  }

  async function pump() {
    timer = null;
    if (busy) return;
    busy = true;
    let next = null;
    try {
      next = await step();
    } catch {
      next = backoff();
    }
    busy = false;
    if (next !== null) {
      nextAt = now() + next;
      schedule();
    }
  }

  return {
    /** Begin sending, after a random head start so a fleet does not open its connections on the same second. `afterNotice`: the notice has only just appeared, so the wait has a floor. */
    start({ afterNotice = false } = {}) {
      if (started) return;
      started = true;
      const floor = afterNotice ? NOTICE_FLOOR_MS : 0;
      notBefore = now() + floor + random() * (FIRST_FLUSH_MAX_MS - floor);
      schedule();
    },
    /** Something was queued, or a gate opened: send when the pacing allows. */
    kick: () => schedule(),
    stop() {
      started = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    /** One event, up to three tries a few seconds apart, then gone. Resolves true when the server took it. */
    async sendBestEffort(rec, id) {
      for (const wait of BEST_EFFORT_WAITS_MS) {
        if (wait) await sleep(wait);
        try {
          const body = trackBody(rec, id);
          if (!body) return false;
          if (classify(await send(body)) === "ok") return true;
        } catch {}
      }
      return false;
    },
  };
}

module.exports = { createSender, classify, retryAfterMs, PACE_MS, BACKOFF_MAX_MS };
