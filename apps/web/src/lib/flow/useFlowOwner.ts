"use client";

import { useEffect, useRef } from "react";
import { toolSummary, type ErrorClass, type FlowCloseReason, type FlowContextWire, type FlowEventWire } from "@openlive/shared";
import { LiveClient, type PermissionOption, type ToolBridgeOp } from "@/lib/live/liveClient";
import { VoiceEngine, type EnginePhase } from "@/lib/live/voiceEngine";
import { loadModels, modelsCached, modelsMatchConfig } from "@/lib/live/models";
import { browserModels, loadPipelineConfig } from "@/lib/live/pipelineConfig";
import { classifyYesNo, optionForVerdict } from "@/lib/live/modalAnswer";
import { agentToolLabel, toolActive } from "@/lib/live/toolMeta";
import { NO_CALL, openliveBridge, type PanelCmd } from "@/lib/live/panelBridge";
import type { PendingPermission } from "@/lib/live/liveStore";
import { log } from "@/lib/log";
import { featureUsed } from "@/lib/featureUse";
import { noteLastFailure } from "@/lib/reportProblem";
import { telemetry } from "@/lib/telemetry";
import { brainIdOf } from "@/lib/telemetryIds";
import { perf } from "@/lib/live/perf";
import { speechFacts } from "@/lib/live/speechFacts";
import { CameraCapture } from "@/lib/live/cameraCapture";
import { desktopPlatform } from "@/lib/platform";
import { createDictate, HISTORY_CHANNEL, readRewrite, type Typing } from "@/lib/dictate/run";
import type { SpokenCommand } from "@/lib/dictate/words";
import { hotkeyKeys } from "@/lib/dictate/hotkey";
import { flowBridge, valueOr, type Guarded } from "./bridge";
import { createTalk } from "./talk";
import { deriveFailure, forOrb, turnFailure } from "./failure";
import { decideQuiet, NO_SIGNALS, type QuietRules, type QuietSignals } from "./quiet";
import { cardWatch, openFact, ownerFactProps, trayAsk, type FailureOrigin, type OpenedBy } from "./ownerFact";
import { IDLE_FLOW, type FlowFailure, type FlowPhase, type FlowSnapshot } from "./types";
import { flowTurn } from "@openlive/flow-store/shared";
import type { FlowConfig, TalkMode } from "@openlive/flow-store";

// Flow's owner renderer. It holds the microphone, the voice cascade, the Flow
// socket and every decision; the orb is a display and command surface fed from
// here. It runs hidden, so nothing in it may depend on being painted.

const BANDS_MS = 66;        // the orb, ~15 fps
// Flow closes on the gesture, or once nothing has been said for "Close after
// silence". This stands in until the settings have been read.
const IDLE_RETIRE_MS = 30_000;
const IDLE_BANDS = [0, 0, 0, 0, 0];
// A camera needs a moment between opening and having a frame to give.
const CAMERA_TRIES = 20;
const CAMERA_WAIT_MS = 100;
// macOS never calls back when a permission is granted, so an unarmed runtime asks.
const ARM_WATCH_MS = 1000;
// A turn that stops saying anything at all. Every event from the server pushes
// this out, so a long tool call or a slow brain is never cut short; what it
// catches is an answer that will not arrive, which otherwise left the orb
// thinking forever with the microphone open and the gesture dead.
const ANSWER_SILENCE_MS = 90_000;
const ARM_WATCH_MAX_ERRORS = 5;
const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const NONE: never[] = [];
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } } as const;

/** Chunked so a megapixel frame cannot blow the argument limit of `apply`. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

interface FlowSettings {
  talk: FlowConfig["talk"];
  brain: FlowConfig["brain"];
  insertion: FlowConfig["insertion"];
  voice: { speakReplies: boolean; autoQuiet: QuietRules } & Pick<FlowConfig["voice"], "turn" | "turnOverride">;
  dictate: FlowConfig["dictate"];
}

const asRules = (s: FlowSettings): QuietRules => ({ ...s.voice.autoQuiet, speakReplies: s.voice.speakReplies });

export function useFlowOwner(): void {
  const snap = useRef<FlowSnapshot>({ ...IDLE_FLOW });
  const permission = useRef<PendingPermission | null>(null);
  const client = useRef<LiveClient | null>(null);
  const engine = useRef<VoiceEngine | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  const settings = useRef<FlowSettings | null>(null);
  const brainReady = useRef(false);
  const turnActive = useRef(false);
  const summoned = useRef(false);
  const disarmed = useRef(false);
  /** Whether the hook was installed. Main registers the keys on it. */
  const armed = useRef(false);
  const answerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One insertion stream at a time: a new call id closes the previous one, so the
  // addon never has two sessions typing into the same cursor.
  const insertion = useRef<{ id: string; session: number } | null>(null);
  // The sentence the side talk check dropped last, as the orb shows it (snapshot `aside`).
  const aside = useRef<{ text: string; speaker?: string; judged?: string } | null>(null);

  useEffect(() => {
    const api = flowBridge();
    const panel = openliveBridge();
    if (!api || !panel) return; // not the desktop app: Flow has nothing to own

    // ── publishing ────────────────────────────────────────────────────────
    const publish = () => panel.panelState?.({ k: "s", s: { ...NO_CALL, permission: permission.current, flow: forOrb(snap.current, summoned.current) } });
    const patch = (p: Partial<FlowSnapshot>) => { snap.current = { ...snap.current, ...p }; publish(); };
    const setPhase = (phase: FlowPhase, detail = "") => {
      if (snap.current.phase === phase && snap.current.detail === detail) return;
      patch({ phase, detail });
    };

    // ── how you talk ──────────────────────────────────────────────────────
    // One mode for Flow and Dictate, read from the settings every time, so a
    // change made mid-session applies from the next utterance.
    const talkMode = (): TalkMode => settings.current?.talk.mode ?? "handsFree";
    /** `live`: the hold's microphone gives sound (onHoldLive), kept while the same hold lasts. */
    const publishTalk = (holding: boolean, live = holding && snap.current.talk.live) => {
      const keys = settings.current ? hotkeyKeys(settings.current.talk.pttKey, desktopPlatform) : [];
      const was = snap.current.talk;
      if (was.mode !== talkMode() || was.holding !== holding || was.live !== live || was.keys.join() !== keys.join()) patch({ talk: { mode: talkMode(), keys, holding, live } });
    };

    // What this open interval reports about itself, sent once as Flow closes.
    let fact = openFact("gesture", 0);
    // The provider or agent Flow thinks with, as /api/flow/config last said.
    let brain: { kind?: "api" | "acp"; id?: string } = {};
    const cards = cardWatch();
    const raise = (failure: FlowFailure | null, origin: FailureOrigin) => {
      const code = cards.appears(failure?.code ?? null);
      // Health also runs while Flow is closed, when no card is on screen.
      if (!code || !summoned.current) return;
      fact.failureCards++;
      fact.lastFailure = code;
      noteLastFailure(code);
      const id = brainIdOf(brain.id);
      telemetry.track("flow_failure_card", { code, origin, ...(brain.kind && { brain_kind: brain.kind }), ...(id && { brain_id: id }) });
    };

    const stopAnswerWatchdog = () => {
      if (!answerTimer.current) return;
      clearTimeout(answerTimer.current);
      answerTimer.current = null;
    };
    /** Pushed out by every event of the turn, so only silence trips it. */
    const armAnswerWatchdog = () => {
      stopAnswerWatchdog();
      answerTimer.current = setTimeout(() => {
        answerTimer.current = null;
        if (!turnActive.current) return;
        loseTurn("That answer never came back", "Nothing more arrived for a minute and a half, so the turn was let go. Just say it again.", "silence");
      }, ANSWER_SILENCE_MS);
    };

    /**
     * The turn is over and there is no answer: the reply went to a socket that
     * is gone, or the brain stopped saying anything. Named on the orb, because
     * silence that looks like thinking is the one state a person cannot act on.
     */
    const loseTurn = (title: string, detail: string, cause: "silence" | "link") => {
      if (cause === "silence") fact.lostSilence++;
      else fact.lostLink++;
      const failure: FlowFailure = { code: "answer_lost", title, detail, actionLabel: "" };
      patch({ failure });
      raise(failure, cause === "silence" ? "lost_answer" : "link");
      failTurn("");
    };

    // Which open is current. Closing voids it, so an open still awaiting the
    // voice check or the microphone when Flow was closed stops there instead of
    // switching the mic on behind an orb that is already gone.
    let openTicket = 0;

    const summon = (by: OpenedBy = "gesture") => {
      talk.stopSilence();
      if (!summoned.current) { summoned.current = true; fact = openFact(by, perf.mark()); api.summon(); }
      publish();
    };
    const dismiss = (reason: FlowCloseReason = "other") => {
      if (!summoned.current) return;
      // Dictate is drawn on this orb, so it goes with it.
      dictate.yield();
      talk.closed("flow");
      summoned.current = false;
      openTicket++;
      talk.stopSilence();
      stopAnswerWatchdog();
      telemetry.fact("flow_owner", ownerFactProps(fact, speechFacts(fact.mark)));
      api.dismiss(reason);
      // The orb is gone, so whatever was running is over. Clearing this BEFORE
      // teardownMic is what lets the microphone actually close: it declines to
      // close one a turn still claims.
      turnActive.current = false;
      snap.current = { ...IDLE_FLOW, failure: snap.current.failure, talk: snap.current.talk };
      publish();
      teardownMic();
    };

    /**
     * A turn that ended badly. The orb stays up with the reason on it, but the
     * microphone closes and the coordinator is told the pipeline is finished,
     * because an error is not a reason to keep recording or to stop answering
     * the key. Without this a quiet turn that failed wedged both forever.
     */
    const failTurn = (message: string, code?: ErrorClass) => {
      turnActive.current = false;
      stopAnswerWatchdog();
      // An error shows on the orb as a failure, never as `reply`, so a reason has to become one.
      const failure = message ? turnFailure(message, brain.kind === "acp", code) : null;
      patch(failure ? { reply: message, failure } : { reply: message });
      if (failure) raise(failure, "turn");
      setPhase("error");
      teardownMic();
      talk.armSilence();
    };

    // ── health ────────────────────────────────────────────────────────────
    // Settings are re-read here rather than remembered from launch: a provider
    // key added after the app started is the commonest way "no brain is
    // configured" used to stick, and that failure outranks the real one.
    const refreshHealth = async () => {
      await loadSettings();
      const c = valueOr(await api.capabilities(), null);
      const failure = deriveFailure({
        platform: c?.platform ?? "",
        accessibility: c?.permissions ? c.permissions.accessibility : null,
        secureInput: !!c?.secureInput?.active,
        hookError: c?.hookError ?? null,
        addonError: c?.addonError ?? null,
        packaged: !!c?.packaged,
        brainReady: brainReady.current,
        online: typeof navigator === "undefined" || navigator.onLine,
        modelsCached: modelsCached(),
        voiceModels: browserModels(loadPipelineConfig()),
      });
      patch({ failure });
      raise(failure, "health");
    };

    // ── arming ────────────────────────────────────────────────────────────
    const arm = async () => {
      if (!settings.current || disarmed.current) return;
      const granted = valueOr(await api.permissions(), null)?.accessibility;
      // `init` is what asks for Accessibility, and onboarding owns that prompt,
      // so Flow only installs the hook once the grant already exists.
      if (!granted) { armed.current = false; return; }
      // Main puts the settings' keys on the hook as it starts.
      await api.init();
      armed.current = true;
    };

    /** The settings the runtime actually runs on. */
    const loadSettings = async (): Promise<void> => {
      try {
        const r = await fetch("/api/flow/config", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { config: FlowSettings; brainReady: boolean; brainKind?: "api" | "acp"; brainId?: string; editReady: boolean };
        settings.current = body.config;
        // Dictate turned off closes a session still open: its key is no longer watched.
        if (!body.config.dictate.enabled) dictate.yield();
        talk.modeChanged();
        publishTalk(talk.holding());
        brainReady.current = body.brainReady;
        editReady = body.editReady;
        brain = { kind: body.brainKind, id: body.brainId };
        if (!armed.current) await arm();
      } catch (e) { log.error("flow", "config:", e); }
    };

    // ── the cascade ───────────────────────────────────────────────────────
    // The microphone is held only while Flow or Dictate is open, and in push to
    // talk only while the key is down: Flow has no wake word and never listens
    // while it is closed.
    const ensureEngine = async () => {
      if (engine.current) return;
      if (starting.current) return starting.current;
      starting.current = (async () => {
        const eng = new VoiceEngine({
          onPhase: onEnginePhase,
          onPartial: (text) => dictate.partial(text),
          onUserText: (text, wordsAt, speaker, _judged, aside) => void onUserText(text, wordsAt, speaker, aside),
          onSideTalk: (text, speaker, judged) => { aside.current = { text, speaker, judged }; patch({ aside: text }); },
          // The first chunk that actually STARTS playing is when speaking begins;
          // the text itself is accumulated from the stream, ahead of the voice.
          onAgentText: () => setPhase("speaking"),
          onHold: () => {},
          onBargeIn: (spokenSoFar) => {
            // The only thing that stops a turn: the abort travels to the server,
            // which aborts the run's signal, and only what was voiced is kept.
            fact.bargeIns++;
            client.current?.flowCancel(spokenSoFar);
            turnActive.current = false;
            patch({ reply: "" });
          },
          // While an approval chip is up, speech is the ANSWER, never a barge-in.
          holdBargeIn: () => !!permission.current,
          answersAsk: (text) => !!permission.current && !!classifyYesNo(text),
          onMicLost: () => void recoverMic(eng),
          onSpeechStart,
          onHoldLive: () => { if (snap.current.talk.holding) publishTalk(true, true); },
        // Flow's own wait when its override is on, else the shared one the
        // engine reads from the pipeline config.
        // No listening sounds hands-free: a pause there is often the user acting, not thinking aloud.
        }, undefined, { ...(settings.current && flowTurn(settings.current)), backchannels: false });
        eng.setGate(talkMode() === "ptt");
        try { await eng.start(() => navigator.mediaDevices.getUserMedia({ audio: MIC })); }
        catch (e) {
          // A half-started engine already holds an audio context, and "Try again"
          // opens a new mic rather than reusing this one.
          eng.stop();
          throw e;
        }
        engine.current = eng;
      })().catch((e) => { log.error("flow", "mic:", e); }).finally(() => { starting.current = null; });
      return starting.current;
    };

    /** The mic went away mid-session, or a press could not open it: carry on
     *  with the default device, or say why Flow cannot hear and close the dead
     *  one, so "Try again" reopens it. */
    const recoverMic = async (eng: VoiceEngine) => {
      try {
        // Push to talk opens it only at the next press, so it is tried now and let go.
        if (talkMode() === "ptt") (await navigator.mediaDevices.getUserMedia({ audio: MIC })).getTracks().forEach((t) => t.stop());
        if (engine.current !== eng) return;
        await eng.reopen();
      } catch (e) {
        log.error("flow", "mic lost:", e);
        if (engine.current !== eng) return;
        const failure: FlowFailure = {
          code: "mic_failed",
          title: "The microphone went away",
          detail: "It was unplugged or its access was turned off. Nothing was lost; try again once it is back.",
          actionLabel: "Try again",
        };
        fact.micLost++;
        patch({ failure });
        raise(failure, "mic");
        setPhase("error");
        teardownMic();
        talk.armSilence();
      }
    };

    const teardownMic = () => {
      if (turnActive.current) return;
      try { engine.current?.stop(); } catch { /* */ }
      engine.current = null;
    };

    const onEnginePhase = (p: EnginePhase) => {
      if (dictate.active()) return dictate.hearing(p === "listening");
      if (p === "listening") return setPhase("listening");
      if (p === "speaking") return setPhase("speaking");
      // The question has been voiced and the reply waits on the answer.
      if (p === "thinking" && permission.current) return setPhase("confirming");
      // The session is still open and the microphone is still on: the resting
      // state between turns is listening, not gone.
      if (p === "idle" && !turnActive.current) backToListening();
    };

    /** Hands-free, the user started talking: the silence starts over, and an
     *  utterance Dictate takes reads the selection it begins on. */
    const onSpeechStart = () => {
      if (dictate.active()) dictate.speechStart();
      talk.speechStart();
    };

    /** A turn ended and the session did not. Flow waits for the next sentence. */
    const backToListening = () => {
      if (!summoned.current) return;
      if (snap.current.phase !== "error") setPhase("listening");
      talk.armSilence();
    };

    // ── the session ───────────────────────────────────────────────────────
    // The gesture opens Flow and the gesture closes it. In between the
    // microphone stays on and Smart-Turn decides where each sentence ends, so
    // talking to Flow is talking, with no key in the way.

    const onOpen = async (by: OpenedBy = "gesture") => {
      if (disarmed.current) return;
      const startedAt = performance.now();
      // A failure left from the last session is not news; health re-derives the live one.
      if (!summoned.current) { patch({ failure: null }); cards.clear(); }
      summon(by);
      // Opening Flow closes Dictate, as opening Dictate closes Flow.
      dictate.yield();
      const ticket = ++openTicket;
      setPhase("listening");
      const health = refreshHealth();
      // Cold start: the weights are downloaded but not compiled yet. Show honest
      // progress; the utterance is captured either way and transcribed when the
      // worker is ready, so nothing said here is lost. A session already hearing
      // keeps its worker: a reload would fail the transcription in flight.
      if (!modelsMatchConfig() && modelsCached() && !engine.current) void warm();
      await decideVoice();
      await health;
      if (ticket !== openTicket) return;
      // Nothing to think with, so listening would only take words to nowhere. The
      // failure health just set stays up with its fix instead.
      if (!brainReady.current) {
        fact.ready = "no_brain";
        setPhase("error");
        teardownMic();
        talk.armSilence();
        return;
      }
      patch({ reply: "" });
      await ensureEngine();
      if (ticket !== openTicket) { teardownMic(); return; }
      // The microphone never opened. Flow IS open — the orb is on screen saying
      // so — it just cannot hear, which is a thing to show rather than to undo.
      if (!engine.current) {
        const failure: FlowFailure = {
          code: "mic_failed",
          title: "I could not open the microphone",
          detail: "Something else may still be holding it. Nothing was lost; try again in a moment.",
          actionLabel: "Try again",
        };
        fact.ready = "mic_failed";
        patch({ failure });
        raise(failure, "mic");
        setPhase("error");
        talk.armSilence();
        return;
      }
      engine.current.setMuted(false);
      fact.ready = "ok";
      fact.readyMs = performance.now() - startedAt;
      talk.armSilence();
    };

    /**
     * Whether this turn is spoken out loud. Asked per turn, not per session: a
     * session outlives the meeting that started during it, and an answer read
     * aloud into a call is the one mistake that cannot be taken back.
     */
    const decideVoice = async () => {
      const read = valueOr(await api.signals(), NO_SIGNALS) as QuietSignals;
      // The addon can only say the microphone is busy, not who is using it. Flow
      // may hold it (all session hands-free, around each hold in push to talk),
      // so that may be Flow: the answer reverts to
      // "could not tell" rather than quieting Flow against itself.
      const signals: QuietSignals = { ...read, micBusy: engine.current ? null : read.micBusy };
      const rules = settings.current ? asRules(settings.current) : null;
      const quiet = rules ? decideQuiet(signals, rules) : "";
      patch({ speaking: !quiet });
      return quiet;
    };

    /** Ends the turn on the server, keeping only the part of the reply the person got. */
    const cancelTurn = (close = false) => {
      // Spoken, the reply is cut back to what was heard; quiet, all of it was shown.
      // Cut either way: a quiet turn still left the engine thinking.
      const cut = engine.current?.cutReply();
      const heard = snap.current.speaking ? cut : undefined;
      client.current?.flowCancel(heard ?? (snap.current.reply || undefined), close);
    };

    /** The gesture again, or the orb's close button. Whatever was in flight is
     *  let go: the person asked for Flow to be gone, not to finish first. */
    const onClose = (reason: FlowCloseReason) => {
      cancelTurn(true);
      // The server refuses the open ask on close, so the chip goes with it rather
      // than waiting on a resolution that may never reach a closed orb.
      permission.current = null;
      turnActive.current = false;
      dismiss(reason);
    };

    /**
     * Stop what Flow is doing, and nothing more.
     *
     * Separate from `onClose` because they answer different sentences: "that is
     * not what I meant" ends the action and leaves the microphone open, while
     * "go away" ends Flow. Nothing now interrupts a tool to ask, so this is the
     * only thing standing between the model and the machine mid-turn.
     */
    const onStop = () => {
      fact.stops++;
      cancelTurn();
      // The server refuses the open ask on Stop, as on close.
      permission.current = null;
      turnActive.current = false;
      stopAnswerWatchdog();
      backToListening();
    };

    const onUserText = async (text: string, wordsAt: number[], speaker?: string, aside?: boolean) => {
      // Dictate's words are typed, never sent to the brain and never answered.
      if (dictate.active()) {
        engine.current?.endAgentTurn();
        void dictate.heard(text);
        return;
      }
      if (snap.current.aside) patch({ aside: "" });
      // An approval is open, so this sentence is its answer.
      if (permission.current) return answerByVoice(text);
      // A question that was asked keeps the orb until it has been answered, even
      // if the transcription outlived the dismissal it was racing.
      turnActive.current = true;
      talk.stopSilence();
      summon("late_speech");
      const quiet = await decideVoice();
      if (quiet) fact.quiet[quiet] = (fact.quiet[quiet] ?? 0) + 1;
      telemetry.track("onboarding_step", { step: "first_flow_turn" });
      patch({ reply: "" });
      setPhase("thinking", client.current?.ready ? "" : "Waiting for the connection. This sends as soon as it is back.");
      armAnswerWatchdog();
      const context = valueOr(await api.context(), undefined) as FlowContextWire | undefined;
      client.current?.flowText(text, context, wordsAt, speaker, !snap.current.speaking, aside);
    };

    // A cold start compiles the weights that are already on disk. Nothing is
    // shown for it: the utterance is captured either way and transcribed once
    // the worker is ready, so the wait is invisible rather than reported.
    const warm = async () => {
      try { await loadModels(() => {}, "flow_open"); }
      catch (e) { log.debug("flow", "warm:", e); }
    };

    // ── Dictate ───────────────────────────────────────────────────────────
    // Same microphone, same engine, same orb as Flow; its words go to the
    // cursor instead of the brain.
    // Whether Dictate's brain can edit a selection, as /api/flow/config last said.
    let editReady = false;
    // set_dictation asked mid-turn: Dictate opens, and Flow closes, once that turn is over.
    let dictateAfterTurn = false;
    const startDictateAfterTurn = () => {
      if (!dictateAfterTurn) return;
      dictateAfterTurn = false;
      if (!dictate.isOpen()) void talk.toggleDictate();
    };

    /** Typing at the cursor. None where the focused element is plainly not a
     *  text box; where the platform cannot tell, it types as it always did. */
    const openTyping = async (): Promise<Typing | null> => {
      if (valueOr(await api.focusEditable(), null) === false) return null;
      const ins = settings.current?.insertion;
      const session = valueOr(await api.insertBegin(ins?.method, ins), -1);
      if (session < 0) return null;
      let ok = true;
      return {
        push: async (text) => { ok = (await api.insertPush(session, text)).ok && ok; },
        end: async () => (await api.insertEnd(session)).ok && ok,
      };
    };
    const copyDictation = async (text: string) => {
      const bridge = (window as unknown as { openlive?: { bridge?: (o: string, a?: string) => Promise<string> } }).openlive?.bridge;
      try { return bridge ? (await bridge("clipboard_write", text), true) : false; }
      catch { return false; }
    };

    const dictate = createDictate({
      // The session holds the microphone from open to close, whichever way it listens.
      listen: async () => {
        if (!modelsMatchConfig() && modelsCached() && !engine.current) void warm();
        await ensureEngine();
        engine.current?.setMuted(false);
        engine.current?.setGate(talkMode() === "ptt");
        return !!engine.current;
      },
      beginHold: () => engine.current?.beginPtt(),
      endHold: async (lateMs) => (await engine.current?.endPtt(true, lateMs)) ?? "heard",
      dropHold: () => engine.current?.dropPtt(),
      ready: () => !!engine.current,
      typing: openTyping,
      copy: copyDictation,
      // What was still being said or transcribed is dropped, and with Flow closed
      // the microphone closes at once: the indicator goes out with Dictate.
      release: () => {
        talk.closed("dictate");
        engine.current?.discard();
        if (!summoned.current) teardownMic();
      },
      show: (d) => {
        if (d && !summoned.current && !snap.current.dictate) api.summon("dictate");
        patch({ dictate: d });
        if (d) return;
        if (summoned.current) return backToListening();
        api.dismiss("other");
      },
      rewrite: async (ask, signal, onText) => {
        const r = await fetch("/api/dictate/rewrite", { ...JSON_POST, body: JSON.stringify(ask), signal });
        if (r.ok && r.body) return readRewrite(r.body, (t) => { if (!signal.aborted) onText(t); });
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      },
      warm: () => void fetch("/api/dictate/warm", { ...JSON_POST, body: "{}" }).catch(() => {}),
      // The accessibility API alone. A copy would read the whole line in many
      // editors with nothing selected, and turn every sentence into an edit.
      selection: async () => valueOr(await api.accessibleSelection(), null),
      keys: async (keys, times) => (await api.keys(keys, times)).ok,
      record: (d) => void (async () => {
        const front = valueOr(await api.device("foreground", {}), null) as { appName?: string; id?: number } | null;
        await fetch("/api/dictate/history", { ...JSON_POST, body: JSON.stringify({ ...d, app: front?.appName, windowId: front?.id }) });
        const ch = new BroadcastChannel(HISTORY_CHANNEL); ch.postMessage(null); ch.close();
      })().catch((e) => log.debug("flow", "dictate history:", e)),
      settings: () => {
        const own = settings.current?.dictate;
        const commands = own?.commands;
        return {
          rules: own?.cleanup ?? { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true },
          lang: loadPipelineConfig().language,
          words: own?.words ?? NONE,
          snippets: own?.snippets ?? NONE,
          commands: new Set(commands ? (Object.keys(commands) as SpokenCommand[]).filter((c) => commands[c]) : []),
          polish: own?.polish ?? { enabled: false, tone: "natural" },
          canEdit: editReady,
        };
      },
    });

    const talk = createTalk({
      mode: talkMode,
      silenceMs: () => (settings.current ? settings.current.talk.closeAfterSilenceMs : IDLE_RETIRE_MS),
      flow: {
        isOpen: () => summoned.current,
        busy: () => turnActive.current,
        open: () => void onOpen(tray.opener()),
        close: (reason) => (reason === "idle" ? dismiss("idle") : onClose(reason)),
        holdStart: () => {
          const e = engine.current;
          if (!e) return false;
          if (snap.current.aside) patch({ aside: "" });
          e.beginPtt();
          return true;
        },
        holdEnd: async (cancel) => { if (cancel) engine.current?.dropPtt(); else await engine.current?.endPtt(true); },
      },
      dictate,
      gate: (on) => engine.current?.setGate(on),
      holding: publishTalk,
    });

    // ── the Flow socket ───────────────────────────────────────────────────
    const onFlowEvent = (e: FlowEventWire) => {
      if (turnActive.current) armAnswerWatchdog();
      switch (e.type) {
        case "text_delta":
          patch({ reply: snap.current.reply + e.delta });
          if (snap.current.speaking) engine.current?.feedAgentDelta(e.delta);
          else setPhase("thinking");
          return;
        case "tool_start":
          if (snap.current.speaking) engine.current?.endAgentStep();
          return setPhase("acting", e.kind ? agentToolLabel(e.kind, e.target) : toolActive(e.name, e.target));
        case "tool_call":
          // An API brain's call names its arguments only once they are all in.
          return setPhase("acting", toolActive(e.name, toolSummary(e.name, e.args)));
        case "tool_result":
          // Deliberately nothing. A run of tool calls is one continuous piece of
          // work, and bouncing the orb back to thinking between every pair of
          // them made it strobe through three palettes a second. The phase moves
          // again when words arrive or the turn ends, which is when it changed.
          return;
        case "error":
          startDictateAfterTurn();
          if (e.aborted) { turnActive.current = false; backToListening(); return; }
          return failTurn(e.message, e.code);
        case "done":
          turnActive.current = false;
          stopAnswerWatchdog();
          startDictateAfterTurn();
          // Quiet, the engine has nothing to voice but is still thinking until told.
          engine.current?.endAgentTurn();
          if (!snap.current.speaking) backToListening();
          return;
        default:
          return;
      }
    };

    // The same OS bridge chat uses, plus Flow's streaming insertion: the model's
    // words reach the user's cursor before the tool call has finished being written.
    const onToolBridge = async (reqId: string, op: ToolBridgeOp, arg?: string) => {
      const reply = (out: string) => client.current?.toolBridgeResult(reqId, out);
      try {
        if (op === "flow_insert") {
          const { id, chunk } = JSON.parse(arg ?? "{}") as { id?: string; chunk?: string };
          if (!id || !chunk) return reply("");
          if (insertion.current && insertion.current.id !== id) await endInsertion();
          if (!insertion.current) {
            const session = valueOr(await api.insertBegin(settings.current?.insertion.method, settings.current?.insertion), -1);
            if (session < 0) return reply("insertion unavailable");
            insertion.current = { id, session };
          }
          await api.insertPush(insertion.current.session, chunk);
          return reply("ok");
        }
        if (op === "flow_insert_end") { await endInsertion(); return reply("ok"); }
        if (op === "flow_dictate") {
          const on = arg === "on";
          // Started now, it would take the very turn that asked for it.
          dictateAfterTurn = on && turnActive.current;
          if (dictateAfterTurn) return reply("Dictation starts as soon as this reply ends, and Flow closes for it: what the user says next is typed at their cursor.");
          if (!on) return reply(await dictate.setOpen(false));
          await talk.toggleDictate();
          return reply(dictate.isOpen() ? "Dictation is on, and Flow closed for it." : "The microphone could not be opened for dictation.");
        }
        if (op === "flow_context") { const c = await api.context(); return reply(c.ok ? JSON.stringify(c.value) : ""); }
        if (op === "flow_device") {
          const { fn, args } = JSON.parse(arg ?? "{}") as { fn?: string; args?: unknown };
          // The camera is the one thing the main process cannot answer: a
          // MediaStream lives in a renderer. Flow has no always-on camera, so
          // this opens it for exactly one frame and closes it again.
          const r = fn === "camera_frame" ? await cameraFrame() : await api.device(fn ?? "", args ?? {});
          return reply(JSON.stringify(r.ok ? { value: r.value } : { error: r.error }));
        }
        const bridge = (window as unknown as { openlive?: { bridge?: (o: string, a?: string) => Promise<string> } }).openlive?.bridge;
        return reply(bridge ? await bridge(op, arg) : "That isn't available here.");
      } catch (e) {
        log.error("flow", "bridge:", e);
        reply("That action failed.");
      }
    };

    // Flow never samples the camera in the background: the light comes on for
    // one frame, when a tool asked for it, and goes straight back off.
    const cameraFrame = async (): Promise<Guarded<{ data: string; mime: string } | null>> => {
      const cam = new CameraCapture();
      try {
        await cam.start();
        let buf: ArrayBuffer | null = null;
        for (let i = 0; i < CAMERA_TRIES && !buf; i++) {
          buf = await cam.captureHiRes();
          if (!buf) await new Promise((r) => setTimeout(r, CAMERA_WAIT_MS));
        }
        if (!buf) return { ok: false, error: "The camera opened but never produced a frame." };
        return { ok: true, value: { data: base64(buf), mime: "image/jpeg" } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "The camera could not be opened." };
      } finally {
        cam.stop();
      }
    };

    const endInsertion = async () => {
      const open = insertion.current;
      insertion.current = null;
      if (open) await api.insertEnd(open.session);
    };

    // ── approval ──────────────────────────────────────────────────────────
    const onPermission = (reqId: string, question: string, options: PermissionOption[], expiresAt?: number) => {
      permission.current = { reqId, question, options, expiresAt };
      // The chips travel in the packet, not in the phase, and a second ask in one
      // turn leaves the phase already on "confirming" — so publish unconditionally
      // or the orb shows the question with no buttons under it.
      setPhase("confirming");
      publish();
      if (snap.current.speaking) engine.current?.say(question);
    };
    const answer = (optionId: string) => {
      const p = permission.current;
      if (!p) return;
      permission.current = null;
      client.current?.permissionResponse(p.reqId, optionId);
      setPhase(turnActive.current ? "thinking" : "idle");
    };
    const answerByVoice = (text: string) => {
      const verdict = classifyYesNo(text);
      if (verdict) fact.permByVoice++;
      if (!verdict) {
        if (snap.current.speaking) engine.current?.say("Say yes to allow, or no to cancel.");
        else setPhase("confirming", "Say yes to allow, or no to cancel.");
        return;
      }
      answer(optionForVerdict(permission.current?.options ?? [], verdict));
    };

    // ── commands from the orb ─────────────────────────────────────────────
    const offCmd = panel.onPanelCmd?.((c: PanelCmd) => {
      switch (c.t) {
        case "permission": return answer(c.optionId);
        case "flowCancel": return onClose("orb_button");
        case "flowStop": return onStop();
        case "dictateToggle": return void talk.toggleDictate();
        case "dictateUndo": return void dictate.undo();
        case "flowSendAside": {
          const a = aside.current;
          if (a && snap.current.aside) { featureUsed("n_send_aside"); engine.current?.sendAside(a.text, a.speaker, a.judged); }
          return;
        }
        case "flowFix": {
          fact.fixes++;
          if (c.code === "no_accessibility") void api.init().then(refreshHealth);
          else if (c.code === "mic_failed") void onOpen();
          else if (c.code === "models_missing") void warm().then(refreshHealth);
          else if (snap.current.failure?.settings) api.expand(`${snap.current.failure.settings}-settings`);
          // `init` replaces a hook thread that died, and the binding goes back on it.
          else if (c.code === "hook_failed" || c.code === "addon_missing") { armed.current = false; void arm().then(refreshHealth); }
          else void refreshHealth();
          return;
        }
        default:
          return;
      }
    });

    // ── power ─────────────────────────────────────────────────────────────
    // Sleep must leave nothing armed and nothing holding the microphone; waking
    // puts the binding back exactly as it was.
    const power = (window as unknown as { openlive?: { onPower?: (cb: (s: string) => void) => () => void } }).openlive;
    const offPower = power?.onPower?.((state) => {
      // A hold down as the machine sleeps or the screen locks never sees its release.
      if (state === "suspend" || state === "lock-screen") void talk.cancelHold();
      if (state === "suspend") {
        disarmed.current = true;
        turnActive.current = false;
        armed.current = false;
        void api.suspend();
        // Dictate may hold the microphone with Flow closed.
        dictate.yield();
        // A close, not a stop: a stop would leave the orb up through sleep.
        onClose("sleep_or_lock");
        teardownMic();
      } else {
        disarmed.current = false;
        // Flow's off switch mutes its own binding alone, which a resume leaves
        // muted, so Dictate's keys come back either way.
        void api.resume().then(() => arm());
      }
    });

    // ── wiring ────────────────────────────────────────────────────────────
    const tray = trayAsk();
    // The double-taps carry no direction: open and closed are this renderer's
    // to know. Opening one of Flow and Dictate closes the other. Push to talk
    // arrives here only while one is open (main sends it to a call otherwise).
    const offEffect = api.onEffect((e) => talk.effect(e));
    const offSecure = api.onSecureInput(() => void refreshHealth());
    // Flow's off switch hides the orb from the main process, so the session
    // behind it has to close here too or the microphone stays open.
    const offArmed = api.onArmed((on) => { if (!on) onClose("disarmed"); });

    let linkUp = false;
    client.current = new LiveClient({
      // Reconnecting mid-turn means the reply was streaming to a socket that is
      // gone. Nothing will finish it, so say so instead of thinking forever.
      onOpen: () => {
        linkUp = true;
        if (!turnActive.current) return;
        // Said while the link was down: it is still queued and goes out right after this.
        if (client.current?.queued) return setPhase("thinking");
        loseTurn("The connection dropped mid-answer", "The reply was on its way when the link to OpenLive went down. Just ask again.", "link");
      },
      // Every failed retry after a drop is the same outage: only open to reconnecting is a drop.
      onReconnecting: () => { if (linkUp) { linkUp = false; fact.linkDrops++; } },
      onFlow: onFlowEvent,
      onToolBridge: (reqId, op, arg) => void onToolBridge(reqId, op, arg),
      onPermission,
      onPermissionResolved: () => { permission.current = null; publish(); },
      onError: (message, code) => failTurn(message, code),
      // A timer or reminder went off. The orb only says it while Flow is open and
      // speaking; the notification covers the rest.
      onReminder: (title, body) => { if (summoned.current && snap.current.speaking) engine.current?.announce(`${title}: ${body}`); },
    }, { flow: true });
    client.current.connect("");

    void loadSettings().then(refreshHealth);

    // A grant given in System Settings is never reported back on macOS, and the
    // window that asked for it is not this one. Polling while unarmed is what
    // makes a first run start working the moment the switch is flipped, instead
    // of at the next relaunch. It stops as soon as the binding is registered,
    // and after a run of failures rather than hammering a broken bridge.
    let armErrors = 0;
    const armWatch = setInterval(() => {
      if (armed.current || disarmed.current || armErrors >= ARM_WATCH_MAX_ERRORS) return;
      void api.permissions().then((r) => {
        if (!r.ok) { armErrors++; return; }
        armErrors = 0;
        if (r.value.accessibility) return arm().then(refreshHealth);
      });
    }, ARM_WATCH_MS);

    // Settings written in the main window reach the runtime here. Without this
    // every change needed a relaunch to take effect.
    const offSettings = api.onSettingsChanged?.(() => void loadSettings().then(refreshHealth));

    // "Carry on from here" in the Flow window. Only this renderer holds the Flow
    // socket, so the ask crosses windows to get here. The orb says so, because
    // a button that changes something invisible has to show that it did.
    const offResume = api.onResumeSession?.((sessionId) => {
      if (!sessionId || turnActive.current) return;
      client.current?.flowResume(sessionId);
      void onOpen("carry_on");
      setPhase("listening", "Carrying on from that session.");
    });

    // The tray's "Start Flow". Closed, main fires the gesture and this only
    // says whose it was. Open, the gesture would close it, so the fresh session
    // starts here; a turn still running or a question waiting is left to finish.
    const offNew = api.onNewSession?.((wasOpen) => {
      if (!wasOpen) return tray.ask();
      if (turnActive.current || permission.current) return;
      client.current?.flowNew();
      void onOpen("tray_new");
      setPhase("listening", "Started a new session.");
    });

    const bands = setInterval(() => {
      if (!summoned.current && !snap.current.dictate) return;
      const e = engine.current;
      panel.panelState?.({ k: "b", mic: e?.micBands() ?? IDLE_BANDS, agent: e?.agentBands() ?? IDLE_BANDS, agentLevel: e?.agentLevel() ?? 0 });
    }, BANDS_MS);

    const online = () => void refreshHealth();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);

    return () => {
      for (const off of [offPower, offCmd, offEffect, offSecure, offArmed, offSettings, offResume, offNew]) off?.();
      // A Fast Refresh runs this effect again on the same refs: a Dictate left in
      // the snapshot would keep the next one from ever summoning the orb.
      dictate.yield();
      patch({ dictate: null });
      clearInterval(bands);
      clearInterval(armWatch);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      talk.stopSilence();
      stopAnswerWatchdog();
      turnActive.current = false;
      teardownMic();
      client.current?.close();
      client.current = null;
    };
  }, []);
}
