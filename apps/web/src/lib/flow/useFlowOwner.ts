"use client";

import { useEffect, useRef } from "react";
import type { FlowContextWire, FlowEventWire } from "@openlive/shared";
import { LiveClient, type PermissionOption, type ToolBridgeOp } from "@/lib/live/liveClient";
import { VoiceEngine, type EnginePhase } from "@/lib/live/voiceEngine";
import { loadModels, modelsCached, modelsMatchConfig } from "@/lib/live/models";
import { classifyYesNo } from "@/lib/live/modalAnswer";
import { toolMeta } from "@/lib/live/toolMeta";
import { NO_CALL, openliveBridge, type PanelCmd } from "@/lib/live/panelBridge";
import type { PendingPermission } from "@/lib/live/liveStore";
import { log } from "@/lib/log";
import { CameraCapture } from "@/lib/live/cameraCapture";
import { addonActivation, flowBridge, valueOr, type Guarded } from "./bridge";
import { deriveFailure } from "./failure";
import { decideQuiet, NO_SIGNALS, type QuietRules, type QuietSignals } from "./quiet";
import { IDLE_FLOW, type FlowPhase, type FlowSnapshot } from "./types";

// Flow's owner renderer. It holds the microphone, the voice cascade, the Flow
// socket and every decision; the pill is a display and command surface fed from
// here. It runs hidden, so nothing in it may depend on being painted.

const BINDING_ID = "flow";
const BANDS_MS = 66;        // the pill's orb, ~15 fps
const DISMISS_DELAY_MS = 900; // let the last word land before the pill leaves
const IDLE_BANDS = [0, 0, 0, 0, 0];
// A camera needs a moment between opening and having a frame to give.
const CAMERA_TRIES = 20;
const CAMERA_WAIT_MS = 100;
// macOS never calls back when a permission is granted, so an unarmed runtime asks.
const ARM_WATCH_MS = 1000;
// Listening has a ceiling. A key-up the OS never delivered, or a microphone that
// opens and then yields nothing, would otherwise leave the pill saying "keep
// holding" with a running clock until the next trigger happened to arrive. Far
// past any real hold, so a genuine long turn is never cut short.
const MAX_LISTEN_MS = 120_000;
const ARM_WATCH_MAX_ERRORS = 5;

/** Chunked so a megapixel frame cannot blow the argument limit of `apply`. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

interface FlowSettings {
  binding: string;
  activation: string;
  holdThresholdMs: number;
  insertion: { method: string };
  voice: { speakReplies: boolean; bargeIn: boolean; autoQuiet: QuietRules };
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
  const override = useRef<boolean | null>(null); // the pill's speaker toggle, for this session
  const turnActive = useRef(false);
  const summoned = useRef(false);
  const disarmed = useRef(false);
  /** Whether the addon currently holds a registration, and for which trigger. */
  const armed = useRef(false);
  const armedFor = useRef("");
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One insertion stream at a time: a new call id closes the previous one, so the
  // addon never has two sessions typing into the same cursor.
  const insertion = useRef<{ id: string; session: number } | null>(null);
  /** The app the turn's metadata named, so the inserting card can say where the text is going. */
  const targetApp = useRef("");

  useEffect(() => {
    const api = flowBridge();
    const panel = openliveBridge();
    if (!api || !panel) return; // not the desktop app: Flow has nothing to own

    // ── publishing ────────────────────────────────────────────────────────
    const publish = () => panel.panelState?.({ k: "s", s: { ...NO_CALL, permission: permission.current, flow: snap.current } });
    const patch = (p: Partial<FlowSnapshot>) => { snap.current = { ...snap.current, ...p }; publish(); };
    const setPhase = (phase: FlowPhase, detail = "") => {
      if (snap.current.phase !== phase) {
        if (phase === "listening") armListenWatchdog();
        else stopListenWatchdog();
      }
      if (snap.current.phase === phase && snap.current.detail === detail) return;
      patch({ phase, detail });
    };

    const stopListenWatchdog = () => {
      if (!listenTimer.current) return;
      clearTimeout(listenTimer.current);
      listenTimer.current = null;
    };
    const armListenWatchdog = () => {
      stopListenWatchdog();
      listenTimer.current = setTimeout(() => {
        listenTimer.current = null;
        if (snap.current.phase !== "listening") return;
        patch({
          failure: {
            code: "listen_timeout",
            title: "I stopped listening",
            detail: "Nothing came through for two minutes, so the microphone was closed. Hold your key and say it again.",
            actionLabel: "Try again",
          },
        });
        failTurn("");
      }, MAX_LISTEN_MS);
    };

    const summon = () => {
      if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
      if (!summoned.current) { summoned.current = true; api.summon(); }
      publish();
    };
    const dismiss = () => {
      if (!summoned.current) return;
      summoned.current = false;
      stopListenWatchdog();
      api.dismiss();
      // The pill is gone, so whatever was running is over. Clearing this BEFORE
      // teardownMic is what lets the microphone actually close: it declines to
      // close one a turn still claims.
      turnActive.current = false;
      snap.current = { ...IDLE_FLOW, binding: snap.current.binding, failure: snap.current.failure };
      publish();
      teardownMic();
      // The coordinator holds the binding in Processing until the pipeline says
      // it is finished; without this the next press is swallowed as a busy press.
      void api.processingFinished();
    };

    /**
     * A turn that ended badly. The pill stays up with the reason on it, but the
     * microphone closes and the coordinator is told the pipeline is finished,
     * because an error is not a reason to keep recording or to stop answering
     * the key. Without this a quiet turn that failed wedged both forever.
     */
    const failTurn = (message: string) => {
      turnActive.current = false;
      patch({ reply: message, inserting: null });
      setPhase("error");
      teardownMic();
      void api.processingFinished();
    };
    const dismissSoon = () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(dismiss, DISMISS_DELAY_MS);
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
      const s = settings.current;
      if (!s || disarmed.current) return;
      const granted = valueOr(await api.permissions(), null)?.accessibility;
      // `init` is what asks for Accessibility, and onboarding owns that prompt,
      // so Flow only installs the hook once the grant already exists.
      if (!granted) { armed.current = false; return; }
      await api.init();
      // Dropping the old registration first is what makes a rebind take effect:
      // re-registering the same id on a new key would otherwise leave the old
      // key live while settings claimed the new one.
      await api.unregister(BINDING_ID);
      await api.register(BINDING_ID, s.binding, addonActivation(s.activation), s.holdThresholdMs);
      armed.current = true;
      armedFor.current = triggerOf(s);
      patch({ binding: s.binding });
    };

    /** The three fields that decide what the addon is listening for. */
    const triggerOf = (s: FlowSettings) => `${s.binding}|${s.activation}|${s.holdThresholdMs}`;

    /**
     * The settings the runtime actually runs on. Re-arms when the trigger
     * changed, which is what makes a rebind, an activation change or a new hold
     * threshold take effect without a relaunch.
     */
    const loadSettings = async (): Promise<void> => {
      try {
        const r = await fetch("/api/flow/config", { cache: "no-store" });
        const body = (await r.json()) as { config: FlowSettings; brainReady: boolean };
        settings.current = body.config;
        brainReady.current = body.brainReady;
        if (!armed.current || armedFor.current !== triggerOf(body.config)) await arm();
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
          onPartial: (text) => patch({ transcript: text, partial: true }),
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
            patch({ reply: "", inserting: null });
          },
          // While an approval chip is up, speech is the ANSWER, never a barge-in;
          // and with barge-in switched off, talking over Flow never cuts it.
          holdBargeIn: () => !!permission.current || settings.current?.voice.bargeIn === false,
        });
        await eng.start(mic);
        engine.current = eng;
      })().catch((e) => { log.error("flow", "mic:", e); }).finally(() => { starting.current = null; });
      return starting.current;
    };

    const teardownMic = () => {
      if (turnActive.current) return;
      try { engine.current?.stop(); } catch { /* */ }
      engine.current = null;
      try { stream.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      stream.current = null;
    };

    const onEnginePhase = (p: EnginePhase) => {
      if (p === "listening") return setPhase("listening");
      if (p === "speaking") return setPhase("speaking");
      if (p === "idle" && !turnActive.current) dismissSoon();
    };

    // ── a turn ────────────────────────────────────────────────────────────
    // Toggle mode leaves the turn boundary to Smart-Turn; every hold mode makes
    // the release the boundary, which is what push-to-talk already means.
    const usesPtt = () => settings.current?.activation !== "toggle";

    const onStart = async () => {
      if (disarmed.current) return;
      summon();
      setPhase("listening");
      void refreshHealth();
      // Cold start: the weights are downloaded but not compiled yet. Show honest
      // progress; the utterance is captured either way and transcribed when the
      // worker is ready, so nothing said here is lost.
      if (!modelsMatchConfig() && modelsCached()) void warm();
      const read = valueOr(await api.signals(), NO_SIGNALS) as QuietSignals;
      // The addon can only say the microphone is busy, not who is using it. If
      // Flow is still holding it from the last turn, that is Flow, so the answer
      // reverts to "could not tell" rather than quieting Flow against itself.
      const signals: QuietSignals = { ...read, micBusy: engine.current ? null : read.micBusy };
      const rules = settings.current ? asRules(settings.current) : null;
      const quiet = rules ? decideQuiet(signals, rules, override.current) : "";
      patch({ quiet, speaking: !quiet, transcript: "", reply: "", inserting: null });
      targetApp.current = "";
      await ensureEngine();
      // The microphone never opened, so the coordinator must not sit in
      // Capturing waiting for speech that cannot arrive.
      if (!engine.current) { void api.startFailed(); setPhase("error"); return; }
      if (usesPtt()) engine.current.beginPtt();
      else engine.current.setMuted(false);
    };

    const onStop = async () => {
      if (!engine.current) { dismissSoon(); return; }
      if (usesPtt()) await engine.current.endPtt();
      else { engine.current.commitPending(); engine.current.setMuted(true); }
      if (!turnActive.current && snap.current.phase === "listening") dismissSoon();
    };

    const onCancel = () => { if (!turnActive.current) dismiss(); };

    const onUserText = async (text: string) => {
      patch({ transcript: text, partial: false });
      // An approval is open, so this sentence is its answer.
      if (permission.current) return answerByVoice(text);
      turnActive.current = true;
      setPhase("thinking");
      const context = valueOr(await api.context(), undefined) as FlowContextWire | undefined;
      client.current?.flowText(text, context);
    };

    const warm = async () => {
      patch({ warming: 0 });
      try { await loadModels((p) => patch({ warming: p.pct })); }
      catch (e) { log.debug("flow", "warm:", e); }
      finally { patch({ warming: null }); }
    };

    // ── the Flow socket ───────────────────────────────────────────────────
    const onFlowEvent = (e: FlowEventWire) => {
      switch (e.type) {
        case "text_delta":
          patch({ reply: snap.current.reply + e.delta });
          if (snap.current.speaking) engine.current?.feedAgentDelta(e.delta);
          else setPhase("thinking");
          return;
        case "tool_start":
          return setPhase("acting", toolMeta(e.name).active);
        case "tool_args_delta": {
          // The partial arguments carry the whole text written so far, so this is
          // the one place the card's text comes from: the chunks on the insertion
          // bridge are the same words a second time.
          const text = e.argsPartial?.text;
          if (typeof text === "string") patch({ inserting: { text, app: targetApp.current } });
          return;
        }
        case "context":
          targetApp.current = e.context.app ?? "";
          return;
        case "tool_result":
          return setPhase(snap.current.speaking ? "speaking" : "thinking");
        case "error":
          if (e.aborted) { turnActive.current = false; setPhase("idle"); dismissSoon(); return; }
          return failTurn(e.message);
        case "done":
          turnActive.current = false;
          if (snap.current.speaking) engine.current?.endAgentTurn();
          else if (snap.current.phase !== "error") dismissSoon();
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
      // or the pill shows the question with no buttons under it.
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

    // ── commands from the pill ────────────────────────────────────────────
    panel.onPanelCmd?.((c: PanelCmd) => {
      switch (c.t) {
        case "permission": return answer(c.optionId);
        case "flowCancel": {
          client.current?.flowCancel(snap.current.reply);
          turnActive.current = false;
          return dismiss();
        }
        case "flowSpeaker": {
          // The manual override wins in both directions and is remembered for the
          // session, so one tap is never undone by the next heuristic.
          override.current = !snap.current.speaking;
          patch({ speaking: override.current, quiet: override.current ? "" : "off" });
          return;
        }
        case "flowFix": {
          if (c.code === "no_accessibility") void api.init().then(refreshHealth);
          else if (c.code === "models_missing") void warm().then(refreshHealth);
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
    const power = (window as unknown as { openlive?: { onPower?: (cb: (s: string) => void) => void } }).openlive;
    power?.onPower?.((state) => {
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
        void api.resume().then(() => arm());
      }
    });

    // ── wiring ────────────────────────────────────────────────────────────
    api.onEffect((e) => {
      if (e.kind === "start") void onStart();
      else if (e.kind === "stop") void onStop();
      else onCancel();
    });
    api.onSecureInput(() => void refreshHealth());

    client.current = new LiveClient({
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
    api.onSettingsChanged?.(() => void loadSettings().then(refreshHealth));

    // "Carry on from here" in the Flow window. Only this renderer holds the Flow
    // socket, so the ask crosses windows to get here. The pill says so, because
    // a button that changes something invisible has to show that it did.
    api.onResumeSession?.((sessionId) => {
      if (!sessionId || turnActive.current) return;
      client.current?.flowResume(sessionId);
      summon();
      setPhase("idle", "Carrying on from that session. Hold your key and talk.");
      dismissSoon();
    });

    const bands = setInterval(() => {
      if (!summoned.current) return;
      const e = engine.current;
      panel.panelState?.({ k: "b", mic: e?.micBands() ?? IDLE_BANDS, agent: e?.agentBands() ?? IDLE_BANDS });
    }, BANDS_MS);

    const online = () => void refreshHealth();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);

    return () => {
      clearInterval(bands);
      clearInterval(armWatch);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      stopListenWatchdog();
      turnActive.current = false;
      teardownMic();
      void api.unregister(BINDING_ID);
      client.current?.close();
      client.current = null;
    };
  }, []);
}
