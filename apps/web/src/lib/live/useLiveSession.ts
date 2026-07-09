"use client";

import { useCallback, useRef } from "react";
import { chatStore } from "@/lib/chatStore";
import { currentTurnConfig } from "@/lib/settingsStore";
import { streamTurn } from "./turnClient";
import { CameraCapture } from "./cameraCapture";
import { AudioPlayer } from "./audioPlayback";
import { VoiceEngine, type EnginePhase } from "./voiceEngine";
import { loadModels, disposeModels, modelsReady, modelsCached } from "./models";
import { useLiveStore } from "./liveStore";

type HistoryTurn = { role: "user" | "assistant"; text: string };

function abToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// Orchestrates one live call. THICK CLIENT: the VoiceEngine runs VAD+STT+TTS
// on-device; each completed user turn is streamed to /api/turn (a serverless SSE
// route) and the reply text drives the on-device TTS. Barge-in aborts the fetch.
// No persistent socket, no server — Vercel-friendly.
export function useLiveSession(chatId: string) {
  const set = useLiveStore((s) => s.set);
  const engine = useRef<VoiceEngine | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const cam = useRef<CameraCapture | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const assistantId = useRef<string | null>(null);
  const tornDown = useRef(false);
  const onPageHide = useRef<() => void>(() => {});
  const turnAbort = useRef<AbortController | null>(null);
  const history = useRef<HistoryTurn[]>([]);
  // Word-by-word transcript reveal, synced to the VOICE (not the generated stream).
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
    try { turnAbort.current?.abort(); } catch { /* */ }
    try { engine.current?.stop(); } catch { /* */ }
    try { player.current?.close(); } catch { /* */ }
    player.current = null;
    try { cam.current?.stop(); } catch { /* */ }
    if (micStream.current) { micStream.current.getTracks().forEach((t) => t.stop()); micStream.current = null; }
    if (assistantId.current) { chatStore.liveFinish(chatId, assistantId.current); assistantId.current = null; }
    disposeModels();
    engine.current = null; cam.current = null; turnAbort.current = null; history.current = [];
    set({ active: false, phase: "off", downloading: false, downloadPct: 0, cameraOn: false, muted: false, pttEnabled: false, cameraStream: null, turns: [], userCaption: "", userPartial: false, agentCaption: "" });
  }, [chatId, set]);

  const start = useCallback(async () => {
    tornDown.current = false;
    history.current = [];
    chatStore.reset(chatId);
    set({ error: undefined, phase: "connecting", active: true, downloadPct: 0, turns: [], userCaption: "", userPartial: false, agentCaption: "" });
    // Unlock audio NOW, synchronously inside the click gesture (iOS Safari).
    if (!player.current) player.current = new AudioPlayer();
    player.current.resume();
    try {
      if (!modelsReady()) { set({ phase: "loading" }); await loadModels((p) => set({ downloadPct: p.pct, downloadLoaded: p.loaded, downloadTotal: p.total, downloadModels: p.models })); }
      if (tornDown.current) return;

      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const micId = useLiveStore.getState().micId;
      if (micId) audio.deviceId = { exact: micId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      micStream.current = stream;
      if (tornDown.current) { stream.getTracks().forEach((t) => t.stop()); return; }

      const eng = new VoiceEngine({
        onPhase: (p: EnginePhase) => set(p === "listening" ? { phase: p, agentCaption: "" } : { phase: p }),
        onPartial: (text) => set({ userCaption: text, userPartial: true }),
        onUserText: (text) => void handleUserText(text),
        // A chunk just STARTED voicing — drive the caption + the word-by-word transcript.
        onAgentText: (sentence, durationMs) => {
          set({ agentCaption: sentence, agentCaptionMs: durationMs });
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
            if (id !== assistantId.current) return;
            const frac = Math.min(1, (performance.now() - startedAt) / dur);
            const idx = Math.max(1, Math.min(words.length, Math.ceil(frac * words.length)));
            const revealed = words.slice(0, idx).join(" ");
            chatStore.liveSetText(chatId, id, prev ? `${prev} ${revealed}` : revealed);
            if (frac < 1) { revealRaf.current = requestAnimationFrame(step); }
            else { revealRaf.current = null; spokenPrev.current = prev ? `${prev} ${sentence}` : sentence; curChunk.current = null; }
          };
          step();
        },
        // Barge-in: abort the in-flight turn's fetch and drop the stale caption.
        onBargeIn: (spoken) => {
          try { turnAbort.current?.abort(); } catch { /* */ }
          stopReveal();
          spokenPrev.current = spoken; curChunk.current = null;
          if (assistantId.current && spoken) chatStore.liveSetText(chatId, assistantId.current, spoken);
          set({ agentCaption: "", userCaption: "", userPartial: false });
        },
      }, player.current ?? undefined);
      engine.current = eng;
      await eng.start(stream);
      if (tornDown.current) return;

      set({ phase: "idle", error: undefined });
      onPageHide.current = () => teardown();
      window.addEventListener("pagehide", onPageHide.current);
      await refreshDevices();
    } catch (e: any) {
      const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      set({ error: denied ? "Microphone access denied. Allow the mic and try again." : `Couldn't start live mode: ${String(e?.message ?? e)}` });
      teardown();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, set, teardown]);

  // A completed user turn: attach the freshest camera frame, POST it with the
  // running history, and stream the reply into the on-device TTS.
  const handleUserText = useCallback(async (text: string) => {
    // Abort any still-running prior turn (shouldn't normally happen).
    try { turnAbort.current?.abort(); } catch { /* */ }
    const ac = new AbortController();
    turnAbort.current = ac;

    const cameraOn = useLiveStore.getState().cameraOn;
    let frame: { data: string; mime: string } | undefined;
    if (cameraOn && cam.current) {
      const jpeg = await cam.current.captureFreshest();
      if (jpeg) frame = { data: abToBase64(jpeg), mime: "image/jpeg" };
    }

    // Reflect the exchange in the transcript store + local caption.
    const st = useLiveStore.getState();
    const turns = [...st.turns];
    if (st.agentCaption.trim()) turns.push({ role: "agent", text: st.agentCaption.trim() });
    turns.push({ role: "user", text });
    set({ turns: turns.slice(-40), userCaption: "", userPartial: false, agentCaption: "" });

    if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
    resetTranscript();
    assistantId.current = chatStore.liveUserTurn(chatId, null, text);

    const priorHistory = [...history.current];
    history.current.push({ role: "user", text });

    const cfg = currentTurnConfig();
    let assistantText = "";
    await streamTurn(
      { providerId: cfg.providerId, model: cfg.model, apiKey: cfg.apiKey, effort: cfg.effort, history: priorHistory, text, frame, cameraOn },
      (e) => {
        if (e.type === "error") { set({ error: e.message }); return; }
        if (e.type === "text_delta") { assistantText += e.text; engine.current?.feedAgentDelta(e.text); return; }
        if (e.type === "done") {
          engine.current?.endAgentTurn();
          if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
          return;
        }
        if (assistantId.current) chatStore.liveApply(chatId, assistantId.current, e);
      },
      ac.signal,
    );
    // Record what was generated this turn (partial on barge-in) for continuity.
    if (assistantText.trim()) history.current.push({ role: "assistant", text: assistantText.trim() });
    if (turnAbort.current === ac) turnAbort.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, set]);

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

  const setPtt = useCallback((enabled: boolean) => {
    engine.current?.setMuted(enabled);
    set({ pttEnabled: enabled, muted: enabled });
  }, [set]);
  const holdTalk = useCallback((down: boolean) => {
    if (!useLiveStore.getState().pttEnabled) return;
    engine.current?.setMuted(!down);
    set({ muted: !down });
  }, [set]);

  const setMic = useCallback(async (id: string) => {
    set({ micId: id });
    if (!useLiveStore.getState().active || !engine.current) return;
    try {
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: id } };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const old = micStream.current;
      micStream.current = stream;
      await engine.current.setStream(stream);
      old?.getTracks().forEach((t) => t.stop());
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
      const camera = new CameraCapture();
      cam.current = camera;
      try {
        await camera.start(useLiveStore.getState().camId);
        await refreshDevices();
      } catch {
        try { camera.stop(); } catch { /* */ }
        cam.current = null;
        set({ error: "Camera access denied." });
        return;
      }
      set({ cameraOn: true, cameraStream: camera.getStream() ?? null });
    } else {
      cam.current?.stop();
      cam.current = null;
      set({ cameraOn: false, cameraStream: null });
    }
  }, [set, refreshDevices]);

  const getLevels = useCallback(() => ({ mic: engine.current?.micLevel() ?? 0, agent: engine.current?.agentLevel() ?? 0 }), []);
  const getSpeechProgress = useCallback(() => engine.current?.speechProgress() ?? 1, []);

  return { start, stop, download, toggleMute, setPtt, holdTalk, toggleCamera, getLevels, getSpeechProgress, refreshDevices, setMic, setCam };
}
