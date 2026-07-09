"use client";

import { useCallback, useRef } from "react";
import { chatStore } from "@/lib/chatStore";
import { LiveClient } from "./liveClient";
import { CameraCapture } from "./cameraCapture";
import { AudioPlayer } from "./audioPlayback";
import { VoiceEngine, type EnginePhase } from "./voiceEngine";
import { loadModels, disposeModels, modelsReady, modelsCached } from "./models";
import { useLiveStore } from "./liveStore";

// Orchestrates one live call. THICK CLIENT: the VoiceEngine runs VAD+STT+TTS
// on-device; this hook wires it to the /live socket (final text + camera frames
// + cancel), the camera, and the chat store, and owns a single leak-proof
// teardown that every close path routes through.
export function useLiveSession(chatId: string, productSlug: string | null) {
  const set = useLiveStore((s) => s.set);
  const client = useRef<LiveClient | null>(null);
  const engine = useRef<VoiceEngine | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const cam = useRef<CameraCapture | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const assistantId = useRef<string | null>(null);
  const tornDown = useRef(false);
  const onPageHide = useRef<() => void>(() => {});
  // Word-by-word transcript reveal, synced to the VOICE (not the generated stream):
  // `spokenPrev` = chunks fully voiced, `curChunk` = the one revealing now, `revealRaf`
  // = its animation frame. So the chat text always equals what's actually been said.
  const spokenPrev = useRef("");
  const curChunk = useRef<string | null>(null);
  const revealRaf = useRef<number | null>(null);
  const stopReveal = () => { if (revealRaf.current != null) { cancelAnimationFrame(revealRaf.current); revealRaf.current = null; } };
  const resetTranscript = () => { stopReveal(); spokenPrev.current = ""; curChunk.current = null; };

  // ── single teardown authority — releases EVERYTHING, always ───────────────
  const teardown = useCallback(() => {
    if (tornDown.current) return;
    tornDown.current = true;
    stopReveal();
    window.removeEventListener("pagehide", onPageHide.current);
    try { client.current?.close(); } catch { /* */ }
    try { engine.current?.stop(); } catch { /* */ }              // destroys VAD + closes audio
    try { player.current?.close(); } catch { /* */ }             // free the audio ctx (also if start() failed before the engine)
    player.current = null;
    try { cam.current?.stop(); } catch { /* */ }                 // camera light off
    if (micStream.current) { micStream.current.getTracks().forEach((t) => t.stop()); micStream.current = null; }
    if (assistantId.current) { chatStore.liveFinish(chatId, assistantId.current); assistantId.current = null; }
    disposeModels();                                             // frees the WebGPU worker
    client.current = null; engine.current = null; cam.current = null;
    // Keep `error` so the user sees why it ended; start() clears it next time.
    set({ active: false, phase: "off", downloading: false, downloadPct: 0, cameraOn: false, screenOn: false, muted: false, pttEnabled: false, cameraStream: null, screenStream: null, turns: [], userCaption: "", userPartial: false, agentCaption: "" });
  }, [chatId, set]);

  const start = useCallback(async () => {
    tornDown.current = false;
    set({ error: undefined, phase: "connecting", active: true, downloadPct: 0, turns: [], userCaption: "", userPartial: false, agentCaption: "" });
    // Unlock audio NOW, synchronously inside the click gesture. iOS Safari blocks
    // AudioContext playback that starts after an await, so priming here (before the
    // model download) is what lets the agent's voice actually play on iPhone.
    if (!player.current) player.current = new AudioPlayer();
    player.current.resume();
    try {
      // 1. Models (download-on-demand, cached). Shows a progress bar the first time.
      if (!modelsReady()) { set({ phase: "loading" }); await loadModels((p) => set({ downloadPct: p.pct, downloadLoaded: p.loaded, downloadTotal: p.total, downloadModels: p.models })); }
      if (tornDown.current) return;

      // 2. Mic stream — chosen device + browser AEC (so the agent's own voice is
      //    cancelled from the mic and can't self-trigger barge-in).
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const micId = useLiveStore.getState().micId;
      if (micId) audio.deviceId = { exact: micId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      micStream.current = stream;
      if (tornDown.current) { stream.getTracks().forEach((t) => t.stop()); return; }

      // 3. Voice engine.
      const eng = new VoiceEngine({
        // Entering "listening" clears the previous answer's caption so the user
        // sees themselves (or "Listening…") the moment they start talking.
        onPhase: (p: EnginePhase) => set(p === "listening" ? { phase: p, agentCaption: "" } : { phase: p }),
        onPartial: (text) => set({ userCaption: text, userPartial: true }),
        onUserText: (text) => void handleUserText(text),
        // A chunk just STARTED voicing. Drive TWO things from it: the composer
        // subtitle (rolling 3-4 word window — VoiceBar reads agentCaption) AND the
        // chat transcript, which types this chunk word-by-word in lockstep with the
        // audio so the panel shows exactly what's been said (honest on barge-in).
        onAgentText: (sentence, durationMs) => {
          set({ agentCaption: sentence, agentCaptionMs: durationMs });
          // The previous chunk's audio has finished (this one is now playing) — commit it.
          if (curChunk.current) spokenPrev.current = spokenPrev.current ? `${spokenPrev.current} ${curChunk.current}` : curChunk.current;
          curChunk.current = sentence;
          stopReveal();
          const id = assistantId.current;
          if (!id) return;
          const words = sentence.split(/\s+/).filter(Boolean);
          const prev = spokenPrev.current;
          const dur = durationMs > 0 ? durationMs : words.length * 320;
          const startedAt = performance.now();
          const step = () => {
            if (id !== assistantId.current) return; // turn moved on
            const frac = Math.min(1, (performance.now() - startedAt) / dur);
            const idx = Math.max(1, Math.min(words.length, Math.ceil(frac * words.length)));
            const revealed = words.slice(0, idx).join(" ");
            chatStore.liveSetText(chatId, id, prev ? `${prev} ${revealed}` : revealed);
            if (frac < 1) { revealRaf.current = requestAnimationFrame(step); }
            else { revealRaf.current = null; spokenPrev.current = prev ? `${prev} ${sentence}` : sentence; curChunk.current = null; }
          };
          step();
        },
        // Barge-in: cancel the server turn AND drop the stale caption immediately,
        // so interrupting gives instant "I'm listening" feedback.
        onBargeIn: (spoken) => {
          client.current?.cancel(spoken);
          // Truncate the assistant node to what was actually spoken — the server
          // persists the same cutoff, so the panel and the saved history agree.
          // Stop the in-flight word reveal and snap the transcript to `spoken`
          // (the engine's authoritative, sentence-granular cutoff).
          stopReveal();
          spokenPrev.current = spoken; curChunk.current = null;
          if (assistantId.current && spoken) chatStore.liveSetText(chatId, assistantId.current, spoken);
          set({ agentCaption: "", userCaption: "", userPartial: false });
        },
      }, player.current ?? undefined);
      engine.current = eng;
      await eng.start(stream);
      if (tornDown.current) return;

      // 4. Socket. Phase stays "connecting" until the socket actually opens — no
      //    more optimistic "Listening" that lies when the connection never lands.
      set({ phase: "connecting" });
      const c = new LiveClient({
        onOpen: () => set({ phase: "idle", error: undefined }),
        onReconnecting: () => set({ phase: "reconnecting" }),
        onClose: () => teardown(),
        onError: (m) => set({ error: m }),
        onSse: (e) => {
          if (e.type === "error") { set({ error: e.message }); return; }
          // Prose text drives the VOICE only; the chat transcript is filled word-by-word
          // as each chunk is spoken (onAgentText), NOT from the generated stream (which
          // races ahead) — so an interrupt leaves the panel showing only what was said.
          if (e.type === "text_delta") { engine.current?.feedAgentDelta(e.text); return; }
          if (e.type === "done") {
            engine.current?.endAgentTurn();
            // Finish the spoken turn but KEEP assistantId pointing at it: a
            // background canvas worker (build_canvas) emits its canvas_end
            // seconds AFTER this `done`, and it must still land on the canvas.
            // assistantId rolls forward on the next user
            // turn (handleUserText) and is finalized on teardown. (Previously it
            // was nulled here, so live-built visuals were silently dropped.)
            if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
            return;
          }
          if (assistantId.current) chatStore.liveApply(chatId, assistantId.current, e);
        },
        onNeedFrame: async (reqId) => {
          const camera = cam.current;
          if (!camera || !(useLiveStore.getState().cameraOn || useLiveStore.getState().screenOn)) { client.current?.frameResponse(reqId); return; }
          const jpeg = await camera.captureHiRes();
          client.current?.frameResponse(reqId);   // server arms for the look frame FIRST
          if (jpeg) client.current?.sendFrame(jpeg);
        },
      });
      client.current = c;
      c.connect(productSlug, chatId);

      onPageHide.current = () => teardown();
      window.addEventListener("pagehide", onPageHide.current);
      await refreshDevices();
    } catch (e: any) {
      const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      set({ error: denied ? "Microphone access denied. Allow the mic and try again." : `Couldn't start live mode: ${String(e?.message ?? e)}` });
      teardown();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, productSlug, set, teardown]);

  // A completed user turn: attach the freshest camera frame, send the text, and
  // reflect the exchange in the chat store (so it renders + persists like typing).
  const handleUserText = useCallback(async (text: string) => {
    if ((useLiveStore.getState().cameraOn || useLiveStore.getState().screenOn) && cam.current) {
      const jpeg = await cam.current.captureFreshest();
      if (jpeg) client.current?.sendFrame(jpeg);
    }
    client.current?.userText(text);
    const st = useLiveStore.getState();
    const turns = [...st.turns];
    if (st.agentCaption.trim()) turns.push({ role: "agent", text: st.agentCaption.trim() });
    turns.push({ role: "user", text });
    set({ turns: turns.slice(-40), userCaption: "", userPartial: false, agentCaption: "" });
    if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
    resetTranscript(); // new turn → the word reveal starts fresh (don't carry prior spoken text)
    assistantId.current = chatStore.liveUserTurn(chatId, productSlug, text);
  }, [chatId, productSlug, set]);

  // Explicit, user-initiated model download (pre-call). Nothing downloads until
  // the user asks — and because the worker stays warm, this only happens once.
  const download = useCallback(async () => {
    if (modelsReady()) { set({ modelsDownloaded: true }); return; }
    set({ downloading: true, downloadPct: 0, error: undefined });
    try {
      await loadModels((p) => set({ downloadPct: p.pct, downloadLoaded: p.loaded, downloadTotal: p.total, downloadModels: p.models }));
      set({ modelsDownloaded: true, downloading: false });
    } catch (e: any) {
      set({ downloading: false, error: `Couldn't download the AI models: ${String(e?.message ?? e)}` });
    }
  }, [set]);

  const refreshDevices = useCallback(async () => {
    // Cached (from a prior session's Cache-API weights) counts as "downloaded" so
    // the pre-call screen never re-asks after a refresh. If cached but the worker
    // isn't warm in THIS page, silently pre-load it in the background so hitting
    // start is instant — no visible progress bar (it reads from cache, fast).
    const cached = modelsCached();
    set({ modelsDownloaded: cached || modelsReady() });
    if (cached && !modelsReady()) void loadModels(() => {}).catch(() => {});
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      set({
        mics: devs.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
        cams: devs.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
      });
    } catch { /* enumerate not available */ }
  }, [set]);

  const stop = useCallback(() => teardown(), [teardown]);

  const toggleMute = useCallback(() => {
    const next = !useLiveStore.getState().muted;
    engine.current?.setMuted(next);
    set({ muted: next });
  }, [set]);

  // Push-to-talk: setPtt(true) mutes until held; holdTalk toggles while held.
  const setPtt = useCallback((enabled: boolean) => {
    engine.current?.setMuted(enabled);
    set({ pttEnabled: enabled, muted: enabled });
  }, [set]);
  const holdTalk = useCallback((down: boolean) => {
    if (!useLiveStore.getState().pttEnabled) return;
    engine.current?.setMuted(!down);
    set({ muted: !down });
  }, [set]);

  // Change the mic — live if a call is active (rebuild the stream + VAD), else it
  // just applies on the next start.
  const setMic = useCallback(async (id: string) => {
    set({ micId: id });
    if (!useLiveStore.getState().active || !engine.current) return;
    try {
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: id } };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const old = micStream.current;
      micStream.current = stream;
      await engine.current.setStream(stream);
      old?.getTracks().forEach((t) => t.stop()); // stop the previous mic only after the swap
    } catch { set({ error: "Couldn't switch microphone." }); }
  }, [set]);

  const setCam = useCallback(async (id: string) => {
    set({ camId: id });
    if (cam.current && useLiveStore.getState().cameraOn) {
      cam.current.stop();
      const c = new CameraCapture();
      cam.current = c;
      try { await c.start(id); set({ cameraStream: c.getStream() ?? null }); }
      catch { cam.current = null; set({ error: "Couldn't switch camera.", cameraStream: null }); }
    }
  }, [set]);

  const toggleCamera = useCallback(async () => {
    const on = !useLiveStore.getState().cameraOn;
    if (on) {
      if (useLiveStore.getState().screenOn) { cam.current?.stop(); cam.current = null; client.current?.control("camera_off"); set({ screenOn: false, screenStream: null }); }
      const camera = new CameraCapture();
      cam.current = camera;
      try {
        await camera.start(useLiveStore.getState().camId);
        await refreshDevices();
      } catch {
        try { camera.stop(); } catch { /* */ }   // stop the stream BEFORE dropping the ref
        cam.current = null;
        set({ error: "Camera access denied." });
        return;
      }
      client.current?.control("camera_on");
      set({ cameraOn: true, cameraStream: camera.getStream() ?? null });
    } else {
      client.current?.control("camera_off");
      cam.current?.stop();
      cam.current = null;
      set({ cameraOn: false, cameraStream: null });
    }
  }, [set, refreshDevices]);

  // Share a screen/window. One visual source at a time, so it turns the camera
  // off. The model sees the shared screen through the same frame pipeline.
  const toggleScreen = useCallback(async () => {
    const on = !useLiveStore.getState().screenOn;
    if (on) {
      if (useLiveStore.getState().cameraOn) { cam.current?.stop(); cam.current = null; client.current?.control("camera_off"); set({ cameraOn: false, cameraStream: null }); }
      const cap = new CameraCapture();
      cam.current = cap;
      try {
        await cap.startScreen(() => {
          // user hit "Stop sharing" in the OS/browser bar
          client.current?.control("camera_off");
          try { cam.current?.stop(); } catch { /* */ }
          cam.current = null;
          set({ screenOn: false, screenStream: null });
        });
      } catch {
        try { cap.stop(); } catch { /* */ }
        cam.current = null;
        set({ error: "Screen share was cancelled." });
        return;
      }
      client.current?.control("camera_on");
      set({ screenOn: true, screenStream: cap.getStream() ?? null });
    } else {
      client.current?.control("camera_off");
      cam.current?.stop();
      cam.current = null;
      set({ screenOn: false, screenStream: null });
    }
  }, [set]);

  const getLevels = useCallback(() => ({ mic: engine.current?.micLevel() ?? 0, agent: engine.current?.agentLevel() ?? 0 }), []);
  const getSpeechProgress = useCallback(() => engine.current?.speechProgress() ?? 1, []);

  return { start, stop, download, toggleMute, setPtt, holdTalk, toggleCamera, toggleScreen, getLevels, getSpeechProgress, refreshDevices, setMic, setCam };
}
