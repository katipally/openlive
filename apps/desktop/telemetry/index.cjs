"use strict";
/**
 * Product-usage telemetry for the desktop app. `createTelemetry` is the only thing main.cjs imports.
 * Everything else in this folder is an implementation detail of it.
 *
 *   const { createTelemetry } = require("./telemetry/index.cjs");
 *   const telemetry = createTelemetry({
 *     userDataDir: app.getPath("userData"),
 *     configPath: path.join(__dirname, "telemetry-config.json"),  // stamped at release; no file, no telemetry
 *     appVersion: app.getVersion(), platform: process.platform, arch: process.arch,
 *     archTranslated: app.runningUnderARM64Translation, osMajor,   // see osMajor below
 *     isPackaged: app.isPackaged, env: process.env, argv: process.argv,
 *     electronNet: net,                                            // `require("electron").net`
 *   });
 *
 * Off means inert: with an unpackaged build, ELECTRON_DEV=1, a debugger flag, OPENLIVE_TELEMETRY=0,
 * DO_NOT_TRACK=1, OPENLIVE_FLOW_HOME or no stamped config, every method below is a no-op and nothing
 * is read or written. `createTelemetry` never throws, and neither does any method. Nothing is sent until
 * the first-run notice has been shown (events wait in memory, never on disk) and only while the person
 * has not turned telemetry off.
 *
 * Deps (all but userDataDir are optional): userDataDir, configPath | config ({ endpoint, clientId, origin }
 * or null), appVersion, platform, arch, archTranslated, osMajor ("15" for macOS 15, "10" or "11" for
 * Windows, "linux"), isPackaged, env, argv, electronNet (else node:https), post, fs, now, random, randomId,
 * timers ({ setTimeout, clearTimeout }), sleep. The last seven exist so tests need no Electron and no network.
 *
 * Stamped config: apps/desktop/telemetry-config.json, git-ignored,
 *   { "endpoint": "https://host", "clientId": "...", "origin": "https://allowed-origin" }
 * Package the runtime files of this folder (index, aggregator, config, feedback, limits, queue, sender, state,
 * transport, username, validate .cjs and schema.json), not the tests.
 *
 * LIFECYCLE
 *   start({ launchKind })   Call in boot(), BEFORE firstTime("loginItemDefault") creates once.json: it needs
 *                           to see whether the app's userData already existed to tell app_first_open's
 *                           origin ("fresh" or "existing_install"). launchKind: "manual" | "login".
 *                           Also queues app_updated and sends a crash-leftover feature_usage. The sender
 *                           starts when the notice is seen: a random 0 to 60 s after launch when it was
 *                           already seen, else 15 to 60 s after the notice is reported shown.
 *   onQuit(via)             Every quit path, once, synchronously: emits any open Flow or call record, the
 *                           feature_usage counters and app_quit (via: tray_menu | app_menu | update_restart |
 *                           no_tray | os_shutdown | boot_failed | other, uptime is measured here), and writes
 *                           state. Safe to call twice.
 *   resume()                The quit onQuit announced did not happen (a failed update restart): sending starts
 *                           again, app_quit included. No-op when no quit was announced.
 *
 * EVENTS FROM MAIN
 *   track(name, props)      Any event of schema.json. Validated, deduped and capped there; a bad prop is
 *                           dropped, a bad required prop drops the event. onboarding_step also gets
 *                           hours_since_first_open, and is sent once per install.
 *   markActiveDay(surface)  app_active_day at most once per local day: "main_window" | "flow" | "call" | "tray".
 *                           Call at the four first-real-action sites, never for a login launch alone.
 *   reportOnboardingStep(step)   Same as track("onboarding_step", { step }).
 *   reportReadiness(props)  flow_readiness_changed. props: { to, perm_accessibility?, perm_post_events?,
 *                           perm_screen?, perm_microphone?, linux_session? }. `from` is the last reported
 *                           value (persisted); an unchanged `to` sends nothing, so poll freely.
 *
 * FLOW AND CALL SUMMARIES (flow_session, call_session)
 *   openFlow()  closeFlow(reason)   summonFlow / finishDismissFlow. reason: gesture | orb_button | idle |
 *                                   disarmed | sleep_or_lock | quit | other. Facts landing up to 2 s after
 *                                   closeFlow still fold in, then the summary is emitted.
 *   openCall()  closeCall(reason)   call-state non-null / null. reason: end_button | orb_end | window_closed |
 *                                   sleep_or_lock | start_failed | switched_chat | app_quit | other. The
 *                                   renderer's own ended_by fact wins, except app_quit.
 *
 * CHANNELS
 *   handleAgentMessage(msg)         P1: call with every child.on("message") payload of the agent. Ignores
 *                                   anything without { openlive: "telemetry", v: 1 }. Accepts facts for scope
 *                                   "flow" | "call" and only the agent's own events.
 *   handleRendererMessage(msg)      P2: call from ipcMain.on("openlive:telemetry", (e, msg)) AFTER the sentBy
 *                                   check for the main window and owner window. msg is one of
 *                                   { t: "track", name, props } | { t: "fact", scope: "flow_owner" |
 *                                   "call_renderer", props } | { t: "count", key } | { t: "notice" } | { t: "feedback", ...answer }.
 *                                   Preload sends exactly these from window.openlive.telemetry.
 *   ipcMain.handle("openlive:telemetry-get", () => telemetry.getStatus())
 *   ipcMain.handle("openlive:telemetry-set", (e, enabled, from) => telemetry.setEnabled(enabled, from))
 *
 * FEEDBACK PROMPTS (feedback.cjs; caps in schema.feedback, state in telemetry.json `prompts`)
 *   feedbackNext()          The prompt the main window may show now, { kind, surface }, or null. Null when sharing is off,
 *                           the notice is owed, a Flow or call record is open, or any cap says wait. Handing one out counts it.
 *                           The answer, { outcome, rating?, score?, reason? }, comes back on P2 as { t: "feedback", ...a }; main
 *                           adds kind, surface and context and sends one feedback_given.
 *   setFeedback(allowed)    Off is "don't ask again", on asks again. getStatus().feedback reads it.
 *
 * SETTINGS
 *   getStatus()             { active, enabled, noticeSeen, installIdTail, username, feedback, appVersion, osName, osMajor }. `username`
 *                           is the install's random name (username.cjs), "" without an ID or while sharing is off.
 *   setEnabled(enabled, from)  Promise. from: "notice" | "settings". Off resolves once the gate is closed and
 *                           the queue is empty; then, in the background, one best-effort telemetry_disabled
 *                           send (three tries, only if the notice was ever shown) and the install ID is
 *                           deleted. On: a fresh install ID, no second app_first_open. An off that telemetry.json could not
 *                           record is kept in a telemetry-off marker (state.cjs) and still wins at the next launch.
 */
const nodeFs = require("node:fs");
const nodeCrypto = require("node:crypto");
const path = require("node:path");
const schema = require("./schema.json");
const { validateEvent, validateFact, validateCommon, isCounterKey, clamp } = require("./validate.cjs");
const { createState, localDay } = require("./state.cjs");
const { createQueue } = require("./queue.cjs");
const { createLimits } = require("./limits.cjs");
const { createSender } = require("./sender.cjs");
const { createAggregator } = require("./aggregator.cjs");
const { createFeedback } = require("./feedback.cjs");
const { electronPost, httpsPost } = require("./transport.cjs");
const { loadConfig, isActive } = require("./config.cjs");
const { usernameOf } = require("./username.cjs");

const BUFFER_MAX = 200;
const OS_NAMES = { darwin: "macOS", win32: "Windows", linux: "Linux" };
// Files main and the web app create under userData: any of them means the app was here before telemetry.
const KNOWN_FILES = ["once.json", "window-state.json", "appearance.json", path.join("data", "settings.json")];
// Who may send what. A process can only report events that are its own.
const RENDERER_EVENTS = new Set([
  "flow_failure_card", "onboarding_step", "setting_changed", "agent_action_result", "lobby_blocked",
  "voice_models_result", "renderer_error",
]);
const RENDERER_SCOPES = new Set(["flow_owner", "call_renderer"]);
const AGENT_EVENTS = new Set([
  "brain_error", "voice_engine_fault", "voice_bench_result", "flow_consent_result", "main_exception", "onboarding_step",
]);
const AGENT_STEPS = new Set(["first_agent_start_ok", "flow_consent_granted", "first_flow_reply", "first_call_reply", "activated"]);
const AGENT_SCOPES = new Map([["flow", "agent_flow"], ["call", "agent_call"]]);

const minute = (ms) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const noop = () => {};
/** Wraps a method so nothing it does can reach the app: telemetry never breaks anything. */
const safe = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch {}
};
const safeAsync = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch {}
};
const ASYNC = new Set(["setEnabled"]);

const METHODS = [
  "start", "track", "getStatus", "setEnabled", "openFlow", "closeFlow",
  "openCall", "closeCall", "handleAgentMessage", "handleRendererMessage", "markActiveDay", "reportOnboardingStep",
  "reportReadiness", "onQuit", "resume", "feedbackNext", "setFeedback",
];

function inert({ appVersion = "", platform = process.platform, osMajor = "" }) {
  const status = { active: false, enabled: false, noticeSeen: false, installIdTail: "", username: "", feedback: false, appVersion, osName: OS_NAMES[platform] ?? platform, osMajor };
  return Object.fromEntries(METHODS.map((m) => [m, m === "getStatus" ? () => ({ ...status }) : m === "setEnabled" ? async () => {} : m === "feedbackNext" ? () => null : noop]));
}

function createTelemetry(deps) {
  const d = isRecord(deps) ? deps : {};
  try {
    return build(d);
  } catch {
    return inert(d);
  }
}

function build(deps) {
  const { userDataDir, appVersion = "", platform = process.platform, arch = process.arch, archTranslated = false, osMajor = "" } = deps;
  const fs = deps.fs ?? nodeFs;
  const config = deps.config !== undefined ? deps.config : deps.configPath ? loadConfig(fs, deps.configPath) : null;
  if (!userDataDir || !isActive({ isPackaged: deps.isPackaged, env: deps.env ?? process.env, argv: deps.argv ?? process.argv, config })) return inert(deps);

  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const newId = deps.randomId ?? nodeCrypto.randomUUID;
  const timers = deps.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)));
  const https = httpsPost(require("node:https"));
  const post = deps.post ?? (deps.electronNet ? electronPost(deps.electronNet, https) : https);

  const state = createState({ dir: userDataDir, fs, timers });
  const data = state.data;
  const queue = createQueue({ dir: userDataDir, fs });
  const limits = createLimits({ schema, state, now });
  const common = validateCommon({ app_version: appVersion, platform, arch, arch_translated: archTranslated, os_major: osMajor });
  const sender = createSender({
    queue, post, config, now, random, timers, sleep,
    gate: () => data.enabled && noticeSeen(),
    profileId: () => data.installId,
  });

  let buffer = [];
  let started = false;
  let quitting = false;
  let startedAt = now();
  let bucketDay = localDay(startedAt);
  let activeDay = "";
  let readiness = data.reportedReadiness;

  const noticeSeen = () => data.noticeSeenAt !== null;
  const pin = (event, prop, v) => clamp(schema.events[event].props[prop], v);
  const hoursSinceFirstOpen = () => pin("onboarding_step", "hours_since_first_open", Math.round((now() - data.firstOpenAt) / 360_000) / 10);
  const daysSinceFirstOpen = () => pin("telemetry_disabled", "days_since_first_open", Math.floor((now() - (data.firstOpenAt ?? now())) / 86_400_000));

  function release({ name, props, at, onRelease }) {
    if (!limits.admit(name, props)) return;
    queue.append({ n: name, p: { ...common, ...props }, t: minute(at) });
    onRelease?.();
    sender.kick();
  }

  /**
   * The one way an event enters: validated, then held until the notice was shown, then limited and queued.
   * `onRelease` runs only when the event is queued, for a marker that must not say "sent" before it was.
   * `at` is when it happened, for an event that is sent later than it was counted.
   */
  function submit(name, raw, onRelease, at = now()) {
    if (!data.enabled) return;
    const props = validateEvent(name, raw);
    if (!props) return;
    const ev = { name, props, at, onRelease };
    if (noticeSeen()) return release(ev);
    buffer.push(ev);
    if (buffer.length > BUFFER_MAX) buffer.shift();
  }

  const aggregator = createAggregator({
    schema, now, random, timers,
    emit: (name, props) => {
      submit(name, props);
      feedback.noteSession(name, props);
    },
  });
  const feedback = createFeedback({ caps: schema.feedback, state, now, submit, open: () => data.enabled && noticeSeen(), busy: aggregator.busy });

  function track(name, props) {
    if (data.enabled && name === "onboarding_step" && props?.step === "activated") feedback.activated();
    submit(name, name === "onboarding_step" && data.firstOpenAt !== null ? { ...props, hours_since_first_open: hoursSinceFirstOpen() } : props);
  }

  function fact(scope, props) {
    if (!data.enabled) return;
    const clean = validateFact(scope, props);
    if (clean && Object.keys(clean).length) aggregator.fact(scope, clean);
  }

  function count(key) {
    if (!data.enabled || !noticeSeen() || !isCounterKey(key)) return;
    const day = localDay(now());
    if (day !== bucketDay) {
      flushCounters();
      bucketDay = day;
    }
    data.featureBucket[key] = Math.min(999, (data.featureBucket[key] ?? 0) + 1);
    data.featureBucketAt = now();
    state.saveSoon();
  }

  function flushCounters() {
    const counts = data.featureBucket;
    if (!Object.keys(counts).length) return;
    submit("feature_usage", counts, () => {
      data.featureBucket = {};
      state.saveSoon();
    }, data.featureBucketAt ?? undefined);
  }

  function sendPendingFirstOpen() {
    const pending = data.pendingFirstOpen;
    if (!pending || !noticeSeen()) return;
    data.pendingFirstOpen = null;
    state.saveSoon();
    submit("app_first_open", pending);
  }

  function start({ launchKind = "manual" } = {}) {
    if (started) return;
    started = true;
    startedAt = now();
    if (!data.enabled) {
      queue.clear();
      data.installId = null;
      return state.save();
    }
    data.installId ??= newId();
    if (data.firstOpenAt === null) {
      data.firstOpenAt = now();
      // A telemetry.json that was there but unreadable already reported this install's first open; the notice is still owed.
      if (!state.existed) data.pendingFirstOpen = { origin: KNOWN_FILES.some((f) => fs.existsSync(path.join(userDataDir, f))) ? "existing_install" : "fresh", launch_kind: launchKind };
    }
    const previous = data.lastVersion;
    const updated = !!previous && previous !== appVersion;
    if (!updated) data.lastVersion = appVersion;
    state.save();
    sendPendingFirstOpen();
    if (updated) {
      submit("app_updated", { from_version: previous, to_version: appVersion }, () => {
        data.lastVersion = appVersion;
        state.saveSoon();
      });
    }
    flushCounters();
    if (noticeSeen()) sender.start();
  }

  function noticeShown() {
    if (!data.enabled || noticeSeen()) return;
    data.noticeSeenAt = now();
    state.save();
    const held = buffer;
    buffer = [];
    sendPendingFirstOpen();
    held.forEach(release);
    sender.start({ afterNotice: true });
  }

  /** Off: the gate closes and the queue empties now; the last event goes out in the background, then the install ID is deleted. */
  function setEnabled(enabled, from) {
    if (enabled === data.enabled) return;
    if (enabled) {
      queue.clear();
      data.enabled = true;
      data.installId = newId();
      limits.reset();
      state.save();
      if (noticeSeen()) sender.start();
      return sender.kick();
    }
    const id = data.installId;
    const props = noticeSeen() && id && validateEvent("telemetry_disabled", { from, days_since_first_open: daysSinceFirstOpen() });
    data.enabled = false;
    data.featureBucket = {};
    buffer = [];
    aggregator.discard();
    feedback.discard();
    queue.clear();
    state.save();
    const forget = () => {
      if (data.enabled) return;
      queue.clear();
      data.installId = null;
      state.save();
    };
    if (!props) return forget();
    const rec = { n: "telemetry_disabled", p: { ...common, ...props }, t: minute(now()) };
    queue.append(rec);
    sender.sendBestEffort(rec, id).then(forget, forget);
  }

  // Only in memory: limits persists the once-a-day cap when the event is released, so a quit before the notice loses nothing.
  function markActiveDay(surface) {
    const day = localDay(now());
    if (!data.enabled || activeDay === day) return;
    activeDay = day;
    feedback.activeToday();
    submit("app_active_day", { first_surface: surface });
  }

  // `readiness` is the last state asked about; the stored one follows only when that event is released.
  function reportReadiness(props) {
    if (!data.enabled || !isRecord(props) || props.to === readiness) return;
    const event = { ...props, from: readiness ?? "unknown" };
    if (!validateEvent("flow_readiness_changed", event)) return;
    const { to } = props;
    readiness = to;
    submit("flow_readiness_changed", event, () => {
      data.reportedReadiness = to;
      state.saveSoon();
    });
  }

  function onQuit(via = "other") {
    feedback.abandon();
    aggregator.flush();
    flushCounters();
    if (!quitting) track("app_quit", { via, uptime_h: pin("app_quit", "uptime_h", Math.round((now() - startedAt) / 360_000) / 10) });
    quitting = true;
    state.save();
    sender.stop();
  }

  /** A quit that was announced did not happen (an update restart that failed): carry on as a running app. */
  function resume() {
    if (!quitting) return;
    quitting = false;
    if (data.enabled && noticeSeen()) sender.start();
  }

  function handleAgentMessage(msg) {
    if (!isRecord(msg) || msg.openlive !== "telemetry" || msg.v !== 1) return;
    if (msg.kind === "fact") {
      const scope = AGENT_SCOPES.get(msg.scope);
      return scope && fact(scope, msg.props);
    }
    if (msg.kind !== "event" || !AGENT_EVENTS.has(msg.name) || !isRecord(msg.props)) return;
    if (msg.name === "onboarding_step" && !AGENT_STEPS.has(msg.props.step)) return;
    track(msg.name, msg.name === "main_exception" ? { ...msg.props, process: "agent" } : msg.props);
  }

  function handleRendererMessage(msg) {
    if (!isRecord(msg)) return;
    if (msg.t === "track" && RENDERER_EVENTS.has(msg.name)) track(msg.name, msg.props);
    else if (msg.t === "fact" && RENDERER_SCOPES.has(msg.scope)) fact(msg.scope, msg.props);
    else if (msg.t === "count") count(msg.key);
    else if (msg.t === "notice") noticeShown();
    else if (msg.t === "feedback") feedback.answer(msg);
  }

  const api = {
    start,
    track,
    getStatus: () => ({
      active: true,
      enabled: data.enabled,
      noticeSeen: noticeSeen(),
      // The ID outlives the toggle by the final send; the screen shows it gone at once.
      installIdTail: data.enabled && data.installId ? data.installId.slice(-4) : "",
      username: data.enabled ? usernameOf(data.installId) : "",
      feedback: feedback.allowed(),
      appVersion,
      osName: OS_NAMES[platform] ?? platform,
      osMajor,
    }),
    setEnabled,
    openFlow: () => data.enabled && aggregator.openFlow(),
    closeFlow: (reason) => aggregator.closeFlow(reason),
    openCall: () => data.enabled && aggregator.openCall(),
    closeCall: (reason) => aggregator.closeCall(reason),
    handleAgentMessage,
    handleRendererMessage,
    markActiveDay,
    reportOnboardingStep: (step) => track("onboarding_step", { step }),
    reportReadiness,
    onQuit,
    resume,
    feedbackNext: () => feedback.next(),
    setFeedback: (allowed) => feedback.allow(!!allowed),
  };
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, ASYNC.has(name) ? safeAsync(fn) : safe(fn)]));
}

module.exports = { createTelemetry };
