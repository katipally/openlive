"use strict";
// How you talk, as main sees it: which keys the hook watches, and where a
// push-to-talk hold goes. main.cjs owns the state; these are pure.

/** The keys to register, from Flow's settings (flow/config.json `talk`): Flow's
 *  and Dictate's double-tap keys, and the push-to-talk key in push to talk only.
 *  A file from before `talk` existed, read raw at launch, gets the defaults; an
 *  undecided mode is hands-free until a renderer decides it. */
function talkBindings(cfg, platform) {
  const talk = cfg?.talk ?? {};
  return {
    flow: talk.flowKey || "ctrl",
    dictate: cfg?.dictate?.enabled ? talk.dictateKey || "option" : null,
    ptt: talk.mode === "ptt" ? talk.pttKey || (platform === "darwin" ? "fn" : "ctrl_right") : null,
  };
}

/** Where each push-to-talk edge goes: "owner" while Flow or Dictate is on the
 *  orb, else "main" while a call is live, else null (dropped). A hold keeps the
 *  place it started in, so its end reaches whoever heard its start even if the
 *  orb closed in between. */
function pttRouter() {
  let latched = null;
  return (kind, { orbUp, callLive }) => {
    if (kind === "hold_start") latched = orbUp ? "owner" : callLive ? "main" : null;
    const to = latched;
    if (kind !== "hold_start") latched = null;
    return to;
  };
}

module.exports = { talkBindings, pttRouter };
