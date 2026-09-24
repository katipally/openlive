"use client";

import { useEffect, useRef } from "react";
import type { FlowContextWire, FlowEventWire } from "@openlive/shared";
import { LiveClient, type PermissionOption, type ToolBridgeOp } from "@/lib/live/liveClient";
import { VoiceEngine, type EnginePhase, type TurnTuning } from "@/lib/live/voiceEngine";
import { loadModels, modelsCached, modelsMatchConfig } from "@/lib/live/models";
import { classifyYesNo } from "@/lib/live/modalAnswer";
import { toolMeta } from "@/lib/live/toolMeta";
import { NO_CALL, openliveBridge, type PanelCmd } from "@/lib/live/panelBridge";
import type { PendingPermission } from "@/lib/live/liveStore";
import { log } from "@/lib/log";
import { CameraCapture } from "@/lib/live/cameraCapture";
import { FLOW_TRIGGER, flowBridge, valueOr, type Guarded } from "./bridge";
import { deriveFailure, turnFailure } from "./failure";
import { decideQuiet, NO_SIGNALS, type QuietRules, type QuietSignals } from "./quiet";
import { IDLE_FLOW, type FlowPhase, type FlowSnapshot } from "./types";

// Flow's owner renderer. It holds the microphone, the voice cascade, the Flow
// socket and every decision; the orb is a display and command surface fed from
// here. It runs hidden, so nothing in it may depend on being painted.

const BINDING_ID = "flow";
const BANDS_MS = 66;        // the orb, ~15 fps
// Flow stays open until the gesture closes it. The "Stay open" setting is only
// the safety net: a session nobody came back to, on a machine somebody walked
// away from. This stands in until the settings have been read.
const IDLE_RETIRE_MS = 5 * 60_000;
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

/** Chunked so a megapixel frame cannot blow the argument limit of `apply`. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

interface FlowSettings {
  idleWindowMs: number;
  brain: { kind: string };
  insertion: { method: string };
  voice: { speakReplies: boolean; bargeIn: boolean; autoQuiet: QuietRules; turn: TurnTuning };
}

const asRules = (s: FlowSettings): QuietRules => ({ ...s.voice.autoQuiet, speakReplies: s.voice.speakReplies });

export function useFlowOwner(): void {
  const snap = useRef<FlowSnapshot>({ ...IDLE_FLOW });
  const permission = useRef<PendingPermission | null>(null);
  const client = useRef<LiveClient | null>(null);
  const engine = useRef<VoiceEngine | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  const settings = useRef<FlowSettings | null>(null);
  const brainReady = useRef(false);
  const turnActive = useRef(false);
  /** The key is up and the words are still being worked out. The orb must not
   *  leave and the microphone must not close during this, or the answer arrives
   *  to a torn-down turn and is never seen. */
  const finalizing = useRef(false);
  const summoned = useRef(false);
  const disarmed = useRef(false);
  /** Whether the addon currently holds a registration. */
  const armed = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One insertion stream at a time: a new call id closes the previous one, so the
  // addon never has two sessions typing into the same cursor.
  const insertion = useRef<{ id: string; session: number } | null>(null);

  useEffect(() => {
    const api = flowBridge();
    const panel = openliveBridge();
    if (!api || !panel) return; // not the desktop app: Flow has nothing to own

    // ── publishing ────────────────────────────────────────────────────────
    const publish = () => panel.panelState?.({ k: "s", s: { ...NO_CALL, permission: permission.current, flow: snap.current } });
    const patch = (p: Partial<FlowSnapshot>) => { snap.current = { ...snap.current, ...p }; publish(); };
    const setPhase = (phase: FlowPhase, detail = "") => {
      if (snap.current.phase === phase && snap.current.detail === detail) return;
      patch({ phase, detail });
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
        loseTurn("That answer never came back", "Nothing more arrived for a minute and a half, so the turn was let go. Just say it again.");
      }, ANSWER_SILENCE_MS);
    };

    /**
     * The turn is over and there is no answer: the reply went to a socket that
     * is gone, or the brain stopped saying anything. Named on the orb, because
     * silence that looks like thinking is the one state a person cannot act on.
     */
    const loseTurn = (title: string, detail: string) => {
      patch({ failure: { code: "answer_lost", title, detail, actionLabel: "" } });
      failTurn("");
    };

    // Which open is current. Closing voids it, so an open still awaiting the
    // voice check or the microphone when Flow was closed stops there instead of
    // switching the mic on behind an orb that is already gone.
    let openTicket = 0;

    const summon = () => {
      stopIdleRetire();
      if (!summoned.current) { summoned.current = true; api.summon(); }
      publish();
    };
    const dismiss = () => {
      if (!summoned.current) return;
      summoned.current = false;
      openTicket++;
      stopIdleRetire();
      stopAnswerWatchdog();
      api.dismiss();
      // The orb is gone, so whatever was running is over. Clearing this BEFORE
      // teardownMic is what lets the microphone actually close: it declines to
      // close one a turn still claims.
      turnActive.current = false;
      finalizing.current = false;
      snap.current = { ...IDLE_FLOW, failure: snap.current.failure };
      publish();
      teardownMic();
      // The gesture is a toggle and the addon holds which way it is thrown. Flow
      // also closes for reasons the addon never sees — this button, the idle
      // timer, sleep — so every close says so, or the next double-tap opens what
      // is already open and the orb becomes uncloseable.
      void api.closed();
    };

    /**
     * A turn that ended badly. The orb stays up with the reason on it, but the
     * microphone closes and the coordinator is told the pipeline is finished,
     * because an error is not a reason to keep recording or to stop answering
     * the key. Without this a quiet turn that failed wedged both forever.
     */
    const failTurn = (message: string) => {
      turnActive.current = false;
      finalizing.current = false;
      stopAnswerWatchdog();
      // The orb draws a failure, never `reply`, so a reason has to become one.
      patch(message ? { reply: message, failure: turnFailure(message, settings.current?.brain.kind === "acp") } : { reply: message });
      setPhase("error");
      teardownMic();
      armIdleRetire();
    };

    const stopIdleRetire = () => {
      if (!idleTimer.current) return;
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    };
    /** Nothing said, nothing running. Pushed out by every turn, so it only ever
     *  fires on a session the person has genuinely walked away from. */
    const armIdleRetire = () => {
      stopIdleRetire();
      idleTimer.current = setTimeout(() => {
        idleTimer.current = null;
        if (turnActive.current || finalizing.current) return;
        dismiss();
      }, settings.current?.idleWindowMs ?? IDLE_RETIRE_MS);
    };

    // ── health ────────────────────────────────────────────────────────────
    // Settings are re-read here rather than remembered from launch: a provider
    // key added after the app started is the commonest way "no brain is
    // configured" used to stick, and that failure outranks the real one.
    const refreshHealth = async () => {
      await loadSettings();
      const c = valueOr(await api.capabilities(), null);
      patch({
        failure: deriveFailure({
          platform: c?.platform ?? "",
          wayland: !!c?.wayland,
          accessibility: c?.permissions ? c.permissions.accessibility : null,
          secureInput: !!c?.secureInput?.active,
          hookError: c?.hookError ?? null,
          brainReady: brainReady.current,
          online: typeof navigator === "undefined" || navigator.onLine,
          modelsCached: modelsCached(),
        }),
      });
    };

    // ── arming ────────────────────────────────────────────────────────────
    const arm = async () => {
      if (!settings.current || disarmed.current) return;
      const granted = valueOr(await api.permissions(), null)?.accessibility;
      // `init` is what asks for Accessibility, and onboarding owns that prompt,
      // so Flow only installs the hook once the grant already exists.
      if (!granted) { armed.current = false; return; }
      await api.init();
      // Dropping the old registration first is what makes a rebind take effect:
      // re-registering the same id on a new key would otherwise leave the old
      // key live while settings claimed the new one.
      await api.unregister(BINDING_ID);
      await api.register(BINDING_ID, FLOW_TRIGGER);
      armed.current = true;
    };

    /** The settings the runtime actually runs on. */
    const loadSettings = async (): Promise<void> => {
      try {
        const r = await fetch("/api/flow/config", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { config: FlowSettings; brainReady: boolean };
        settings.current = body.config;
        brainReady.current = body.brainReady;
        if (!armed.current) await arm();
      } catch (e) { log.error("flow", "config:", e); }
    };

    // ── the cascade ───────────────────────────────────────────────────────
    // The microphone is held only while a turn is in flight: Flow has no wake
    // word and never listens between triggers.
    const ensureEngine = async () => {
      if (engine.current) return;
      if (starting.current) return starting.current;
      starting.current = (async () => {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        stream.current = mic;
        const eng = new VoiceEngine({
          onPhase: onEnginePhase,
          onPartial: () => {},
          onUserText: (text) => void onUserText(text),
          // The first chunk that actually STARTS playing is when speaking begins;
          // the text itself is accumulated from the stream, ahead of the voice.
          onAgentText: () => setPhase("speaking"),
          onHold: () => {},
          onBargeIn: (spokenSoFar) => {
            // The only thing that stops a turn: the abort travels to the server,
            // which aborts the run's signal, and only what was voiced is kept.
            client.current?.flowCancel(spokenSoFar);
            turnActive.current = false;
            patch({ reply: "" });
          },
          // While an approval chip is up, speech is the ANSWER, never a barge-in;
          // and with barge-in switched off, talking over Flow never cuts it.
          holdBargeIn: () => !!permission.current || settings.current?.voice.bargeIn === false,
        // Flow's own turn-taking, not the one a call runs on: cut off in a call
        // the person sees it and presses a key, and here the half-sentence is
        // already answered and acted on.
        }, undefined, settings.current?.voice.turn ?? {});
        await eng.start(mic);
        engine.current = eng;
      })().catch((e) => { log.error("flow", "mic:", e); }).finally(() => { starting.current = null; });
      return starting.current;
    };

    const teardownMic = () => {
      if (turnActive.current || finalizing.current) return;
      try { engine.current?.stop(); } catch { /* */ }
      engine.current = null;
      try { stream.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      stream.current = null;
    };

    const onEnginePhase = (p: EnginePhase) => {
      if (p === "listening") return setPhase("listening");
      if (p === "speaking") return setPhase("speaking");
      // The session is still open and the microphone is still on: the resting
      // state between turns is listening, not gone.
      if (p === "idle" && !turnActive.current && !finalizing.current) backToListening();
    };

    /** A turn ended and the session did not. Flow waits for the next sentence. */
    const backToListening = () => {
      if (!summoned.current) return;
      if (snap.current.phase !== "error") setPhase("listening");
      armIdleRetire();
    };

    // ── the session ───────────────────────────────────────────────────────
    // The gesture opens Flow and the gesture closes it. In between the
    // microphone stays on and Smart-Turn decides where each sentence ends, so
    // talking to Flow is talking, with no key in the way.

    const onOpen = async () => {
      if (disarmed.current) return;
      // A failure left from the last session is not news; health re-derives the live one.
      if (!summoned.current) patch({ failure: null });
      summon();
      const ticket = ++openTicket;
      setPhase("listening");
      const health = refreshHealth();
      // Cold start: the weights are downloaded but not compiled yet. Show honest
      // progress; the utterance is captured either way and transcribed when the
      // worker is ready, so nothing said here is lost.
      if (!modelsMatchConfig() && modelsCached()) void warm();
      await decideVoice();
      await health;
      if (ticket !== openTicket) return;
      // Nothing to think with, so listening would only take words to nowhere. The
      // failure health just set stays up with its fix instead.
      if (!brainReady.current) {
        setPhase("error");
        teardownMic();
        armIdleRetire();
        return;
      }
      patch({ reply: "" });
      await ensureEngine();
      if (ticket !== openTicket) { teardownMic(); return; }
      // The microphone never opened. Flow IS open — the orb is on screen saying
      // so — it just cannot hear, which is a thing to show rather than to undo.
      if (!engine.current) {
        patch({
          failure: {
            code: "mic_failed",
            title: "I could not open the microphone",
            detail: "Something else may still be holding it. Nothing was lost; try again in a moment.",
            actionLabel: "Try again",
          },
        });
        setPhase("error");
        armIdleRetire();
        return;
      }
      engine.current.setMuted(false);
      armIdleRetire();
    };

    /**
     * Whether this turn is spoken out loud. Asked per turn, not per session: a
     * session outlives the meeting that started during it, and an answer read
     * aloud into a call is the one mistake that cannot be taken back.
     */
    const decideVoice = async () => {
      const read = valueOr(await api.signals(), NO_SIGNALS) as QuietSignals;
      // The addon can only say the microphone is busy, not who is using it. Flow
      // holds it for the whole session, so that is Flow: the answer reverts to
      // "could not tell" rather than quieting Flow against itself.
      const signals: QuietSignals = { ...read, micBusy: engine.current ? null : read.micBusy };
      const rules = settings.current ? asRules(settings.current) : null;
      const quiet = rules ? decideQuiet(signals, rules) : "";
      patch({ speaking: !quiet });
    };

    /** The gesture again, or the orb's close button. Whatever was in flight is
     *  let go: the person asked for Flow to be gone, not to finish first. */
    const onClose = () => {
      client.current?.flowCancel(snap.current.reply, true);
      // The server refuses the open ask on close, so the chip goes with it rather
      // than waiting on a resolution that may never reach a closed orb.
      permission.current = null;
      turnActive.current = false;
      dismiss();
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
      client.current?.flowCancel(snap.current.reply);
      turnActive.current = false;
      stopAnswerWatchdog();
      backToListening();
    };

    const onUserText = async (text: string) => {
      // An approval is open, so this sentence is its answer.
      if (permission.current) return answerByVoice(text);
      // A question that was asked keeps the orb until it has been answered, even
      // if the transcription outlived the dismissal it was racing.
      turnActive.current = true;
      stopIdleRetire();
      summon();
      await decideVoice();
      patch({ reply: "" });
      setPhase("thinking", client.current?.ready ? "" : "Waiting for the connection. This sends as soon as it is back.");
      armAnswerWatchdog();
      const context = valueOr(await api.context(), undefined) as FlowContextWire | undefined;
      client.current?.flowText(text, context);
    };

    // A cold start compiles the weights that are already on disk. Nothing is
    // shown for it: the utterance is captured either way and transcribed once
    // the worker is ready, so the wait is invisible rather than reported.
    const warm = async () => {
      try { await loadModels(() => {}); }
      catch (e) { log.debug("flow", "warm:", e); }
    };

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
          return setPhase("acting", toolMeta(e.name).active);
        case "tool_result":
          // Deliberately nothing. A run of tool calls is one continuous piece of
          // work, and bouncing the orb back to thinking between every pair of
          // them made it strobe through three palettes a second. The phase moves
          // again when words arrive or the turn ends, which is when it changed.
          return;
        case "error":
          if (e.aborted) { turnActive.current = false; backToListening(); return; }
          return failTurn(e.message);
        case "done":
          turnActive.current = false;
          stopAnswerWatchdog();
          if (snap.current.speaking) engine.current?.endAgentTurn();
          else backToListening();
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
            const session = valueOr(await api.insertBegin(settings.current?.insertion.method), -1);
            if (session < 0) return reply("insertion unavailable");
            insertion.current = { id, session };
          }
          await api.insertPush(insertion.current.session, chunk);
          return reply("ok");
        }
        if (op === "flow_insert_end") { await endInsertion(); return reply("ok"); }
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
      if (!verdict) {
        if (snap.current.speaking) engine.current?.say("Say yes to allow, or no to cancel.");
        else setPhase("confirming", "Say yes to allow, or no to cancel.");
        return;
      }
      answer(verdict === "allow" ? "allow" : "deny");
    };

    // ── commands from the orb ─────────────────────────────────────────────
    const offCmd = panel.onPanelCmd?.((c: PanelCmd) => {
      switch (c.t) {
        case "permission": return answer(c.optionId);
        case "flowCancel": return onClose();
        case "flowStop": return onStop();
        case "flowFix": {
          if (c.code === "no_accessibility") void api.init().then(refreshHealth);
          else if (c.code === "mic_failed") void onOpen();
          else if (c.code === "models_missing") void warm().then(refreshHealth);
          else if (snap.current.failure?.settings) api.expand(`${snap.current.failure.settings}-settings`);
          // `init` replaces a hook thread that died, and the binding goes back on it.
          else if (c.code === "hook_failed") { armed.current = false; void arm().then(refreshHealth); }
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
      if (state === "suspend") {
        disarmed.current = true;
        turnActive.current = false;
        armed.current = false;
        void api.suspend();
        client.current?.flowCancel(snap.current.reply);
        dismiss();
        teardownMic();
      } else {
        disarmed.current = false;
        // Waking must not undo the tray's disarm: the hook stays suspended for that.
        void api.capabilities().then((c) => (valueOr(c, null)?.armed === false ? undefined : api.resume())).then(() => arm());
      }
    });

    // ── wiring ────────────────────────────────────────────────────────────
    const offEffect = api.onEffect((e) => {
      if (e.kind === "start") void onOpen();
      else if (e.kind === "stop") onClose();
    });
    const offSecure = api.onSecureInput(() => void refreshHealth());
    // The tray's quick disarm hides the orb from the main process, so the session
    // behind it has to close here too or the microphone stays open.
    const offArmed = api.onArmed((on) => { if (!on) onClose(); });

    client.current = new LiveClient({
      // Reconnecting mid-turn means the reply was streaming to a socket that is
      // gone. Nothing will finish it, so say so instead of thinking forever.
      onOpen: () => {
        if (!turnActive.current) return;
        // Said while the link was down: it is still queued and goes out right after this.
        if (client.current?.queued) return setPhase("thinking");
        loseTurn("The connection dropped mid-answer", "The reply was on its way when the link to OpenLive went down. Just ask again.");
      },
      onFlow: onFlowEvent,
      onToolBridge: (reqId, op, arg) => void onToolBridge(reqId, op, arg),
      onPermission,
      onPermissionResolved: () => { permission.current = null; publish(); },
      // A spoken answer that raced its own chip comes back from the server, which
      // is the authority on what is still pending.
      onModalVoiceAnswer: (text) => answerByVoice(text),
      onError: (message) => failTurn(message),
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
      void onOpen();
      setPhase("listening", "Carrying on from that session.");
    });

    // The tray's "New Flow session" with Flow already open. A turn still running
    // or finishing, or a question waiting on an answer, is left to finish.
    const offNew = api.onNewSession?.(() => {
      if (turnActive.current || finalizing.current || permission.current) return;
      client.current?.flowNew();
      void onOpen();
      setPhase("listening", "Started a new session.");
    });

    const bands = setInterval(() => {
      if (!summoned.current) return;
      const e = engine.current;
      panel.panelState?.({ k: "b", mic: e?.micBands() ?? IDLE_BANDS, agent: e?.agentBands() ?? IDLE_BANDS, agentLevel: e?.agentLevel() ?? 0 });
    }, BANDS_MS);

    const online = () => void refreshHealth();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);

    return () => {
      for (const off of [offPower, offCmd, offEffect, offSecure, offArmed, offSettings, offResume, offNew]) off?.();
      clearInterval(bands);
      clearInterval(armWatch);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      stopIdleRetire();
      stopAnswerWatchdog();
      turnActive.current = false;
      teardownMic();
      void api.unregister(BINDING_ID);
      client.current?.close();
      client.current = null;
    };
  }, []);
}
