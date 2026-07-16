"use client";

import { useCallback, useEffect, useRef } from "react";
import { chatStore } from "@/lib/chatStore";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { isAgentId, agentLabel } from "@openlive/shared";
import { notifyDesktop } from "@/lib/platform";
import { LiveClient, type AgentId, type AgentMeta } from "./liveClient";
import { CameraCapture } from "./cameraCapture";
import { AudioPlayer } from "./audioPlayback";
import { VoiceEngine, type EnginePhase } from "./voiceEngine";
import { loadModels, modelsReady, modelsCached } from "./models";
import { useLiveStore } from "./liveStore";

const NO_BANDS = [0, 0, 0, 0, 0];

function abToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// Per-conversation agent bind, remembered browser-side (localStorage) so reopening
// a conversation resumes the same agent. Sent to the server on connect + on change.
function readBind(chatId: string): AgentId | null {
  try { const v = localStorage.getItem(`openlive-bind:${chatId}`); return v && isAgentId(v) ? v : null; } catch { return null; }
}
// Classify a spoken reply to a permission ask; ambiguous → null (keep waiting).
function classifyYesNo(text: string): "allow" | "deny" | null {
  const t = text.toLowerCase();
  if (/\b(yes|yeah|yep|sure|ok|okay|approve|allow|go ahead|do it|confirm|permit|sounds good|please do)\b/.test(t)) return "allow";
  if (/\b(no|nope|deny|don'?t|do not|stop|cancel|reject|decline|never mind)\b/.test(t)) return "deny";
  return null;
}

/** Set a conversation's agent bind (store + localStorage). The live session pushes
 *  the change to the server via its boundAgent effect. Usable outside the call
 *  (e.g. the top-bar selector) — takes effect on the next connect if idle. */
export function setConversationBind(chatId: string, agentId: AgentId | null) {
  useLiveStore.getState().set({ boundAgent: agentId });
  try { localStorage.setItem(`openlive-bind:${chatId}`, agentId ?? ""); } catch { /* private mode */ }
}

function readCwd(chatId: string): string {
  try { return localStorage.getItem(`openlive-cwd:${chatId}`) ?? ""; } catch { return ""; }
}
const RECENT_KEY = "openlive-recent-folders";
/** Recently-used project folders (most-recent first), for the top-bar quick-switch. */
export function recentFolders(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : []; }
  catch { return []; }
}
function addRecentFolder(path: string) {
  if (!path) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentFolders().filter((p) => p !== path)].slice(0, 8))); } catch { /* private mode */ }
}
/** Set a conversation's project folder (store + localStorage + recents). The live
 *  session pushes it to the server (restarting the agent there) via its effect. */
export function setConversationFolder(chatId: string, cwd: string) {
  useLiveStore.getState().set({ boundCwd: cwd });
  try { localStorage.setItem(`openlive-cwd:${chatId}`, cwd); } catch { /* private mode */ }
  addRecentFolder(cwd);
}

// Resuming one of an agent's OWN external sessions (from History): remember the ACP
// session id so the initial bind loadSession-s it. Sent on connect only.
function readResume(chatId: string): string { try { return localStorage.getItem(`openlive-resume:${chatId}`) ?? ""; } catch { return ""; } }
export function setConversationResume(chatId: string, sessionId: string) {
  try { localStorage.setItem(`openlive-resume:${chatId}`, sessionId); } catch { /* private mode */ }
}

// The live client of the ACTIVE session, so top-bar controls (rendered outside the
// hook) can switch the agent's model/mode mid-call. Single session at a time.
let activeLiveClient: LiveClient | null = null;

// An agent only reveals its models/modes over ACP once it connects, so we cache the
// last-seen set per agent — the pre-call pickers populate from this, and the choice
// is remembered as a per-agent preference applied when the call connects.
export function cachedAgentMeta(agentId: AgentId | null): AgentMeta | null {
  if (!agentId) return null;
  try {
    const v = localStorage.getItem(`openlive-meta:${agentId}`);
    if (!v) return null;
    const meta = JSON.parse(v) as AgentMeta;
    if (!Array.isArray(meta.options)) meta.options = []; // tolerate pre-config-options caches
    // Mode + model have their OWN dedicated pickers; drop any config option in those
    // categories so "Mode"/"Model" isn't rendered twice (agents report mode via both
    // SessionModeState and a category:"mode" option — and older caches kept it).
    meta.options = meta.options.filter((o) => o.category !== "mode" && o.category !== "model");
    // Reflect the user's remembered model/mode/option preference (validated against
    // the cached set) so the pre-call pickers show their last choice.
    const mp = localStorage.getItem(`openlive-model:${agentId}`);
    if (mp && meta.models.some((m) => m.id === mp)) meta.currentModelId = mp;
    const dp = localStorage.getItem(`openlive-mode:${agentId}`);
    if (dp && meta.modes.some((m) => m.id === dp)) meta.currentModeId = dp;
    for (const o of meta.options) {
      const p = localStorage.getItem(`openlive-opt:${agentId}:${o.id}`);
      if (p && o.values.some((v) => v.id === p)) o.currentId = p;
    }
    return meta;
  } catch { return null; }
}
const readPref = (key: string) => { try { return localStorage.getItem(key) || null; } catch { return null; } };

export function setConversationModel(modelId: string) {
  const agent = useLiveStore.getState().boundAgent;
  if (agent) { try { localStorage.setItem(`openlive-model:${agent}`, modelId); } catch { /* */ } }
  activeLiveClient?.setModel(modelId);
  const m = useLiveStore.getState().agentMeta ?? cachedAgentMeta(agent);
  if (m) useLiveStore.getState().set({ agentMeta: { ...m, currentModelId: modelId } });
}
export function setConversationMode(modeId: string) {
  const agent = useLiveStore.getState().boundAgent;
  if (agent) { try { localStorage.setItem(`openlive-mode:${agent}`, modeId); } catch { /* */ } }
  activeLiveClient?.setMode(modeId);
  const m = useLiveStore.getState().agentMeta ?? cachedAgentMeta(agent);
  if (m) useLiveStore.getState().set({ agentMeta: { ...m, currentModeId: modeId } });
}
export function setConversationOption(optionId: string, valueId: string) {
  const agent = useLiveStore.getState().boundAgent;
  if (agent) { try { localStorage.setItem(`openlive-opt:${agent}:${optionId}`, valueId); } catch { /* */ } }
  activeLiveClient?.setOption(optionId, valueId);
  const m = useLiveStore.getState().agentMeta ?? cachedAgentMeta(agent);
  if (m) useLiveStore.getState().set({ agentMeta: { ...m, options: m.options.map((o) => (o.id === optionId ? { ...o, currentId: valueId } : o)) } });
}

// Orchestrates one live call. THICK CLIENT: the VoiceEngine runs VAD+STT+TTS
// on-device; this hook wires it to the /live socket (final text + camera frames
// + cancel), the camera, and the chat store, and owns a single leak-proof
// teardown that every close path routes through.
export function useLiveSession(chatId: string) {
  const set = useLiveStore((s) => s.set);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const boundCwd = useLiveStore((s) => s.boundCwd);
  const client = useRef<LiveClient | null>(null);
  const engine = useRef<VoiceEngine | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const camRef = useRef<CameraCapture | null>(null);
  const screenRef = useRef<CameraCapture | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const assistantId = useRef<string | null>(null);
  const permReminder = useRef<ReturnType<typeof setTimeout> | null>(null); // spoken "30s left" nudge
  const turnStartedAt = useRef(0); // notify "finished" only for turns that took real time
  const tornDown = useRef(false);
  const onPageHide = useRef<() => void>(() => {});
  // Word-by-word transcript reveal, synced to the VOICE (not the generated stream):
  // `segText` = chunks of the CURRENT segment already voiced, `curChunk` = the one
  // revealing now, `revealRaf` = its frame. Tool activity is shown LIVE on tool_start
  // (see the onSse handler), not buffered.
  const segText = useRef("");
  const curChunk = useRef<string | null>(null);
  const revealRaf = useRef<number | null>(null);
  const stopReveal = () => { if (revealRaf.current != null) { cancelAnimationFrame(revealRaf.current); revealRaf.current = null; } };
  const resetTranscript = () => { stopReveal(); segText.current = ""; curChunk.current = null; };

  // Desktop mini mode hides this window, which freezes rAF — snap the in-flight
  // word reveal to its full chunk so the saved/visible transcript never stalls
  // mid-word. Voice/TTS are timer-driven and unaffected (backgroundThrottling off).
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden || revealRaf.current == null) return;
      stopReveal();
      const id = assistantId.current;
      if (id && curChunk.current != null) {
        const full = segText.current ? `${segText.current} ${curChunk.current}` : curChunk.current;
        chatStore.liveText(chatId, id, full);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [chatId]);

  // ── single teardown authority — releases EVERYTHING, always ───────────────
  const teardown = useCallback(() => {
    if (tornDown.current) return;
    tornDown.current = true;
    stopReveal();
    if (permReminder.current) { clearTimeout(permReminder.current); permReminder.current = null; }
    window.removeEventListener("pagehide", onPageHide.current);
    if (activeLiveClient === client.current) activeLiveClient = null;
    try { client.current?.close(); } catch { /* */ }
    try { engine.current?.stop(); } catch { /* */ }              // destroys VAD + closes audio
    try { player.current?.close(); } catch { /* */ }             // free the audio ctx (also if start() failed before the engine)
    player.current = null;
    try { camRef.current?.stop(); } catch { /* */ }              // camera light off
    try { screenRef.current?.stop(); } catch { /* */ }             // stop screen share
    if (micStream.current) { micStream.current.getTracks().forEach((t) => t.stop()); micStream.current = null; }
    if (assistantId.current) { chatStore.liveFinish(chatId, assistantId.current); assistantId.current = null; }
    // The on-device voice worker is left running on purpose — kept warm for the
    // tab's lifetime so reopening Live is instant (no re-download / shader recompile).
    client.current = null; engine.current = null; camRef.current = null; screenRef.current = null;
    // Keep `error` so the user sees why it ended; start() clears it next time.
    set({ active: false, phase: "off", downloading: false, downloadPct: 0, cameraOn: false, screenOn: false, muted: false, cameraStream: null, screenStream: null, userCaption: "", userPartial: false, agentCaption: "", toolStatus: "", warming: false, permission: null, agentMeta: null, agentConnecting: false, todos: [], usage: null });
  }, [chatId, set]);

  // Open the live socket + register every handler, binding this conversation's agent
  // the moment it connects. Shared by `prewarm` (pre-call: connect a bound agent to
  // fetch its models/modes) and `start` (layers the voice engine onto the SAME
  // connection — no second agent process). Returns the new or existing client.
  const ensureClient = useCallback((): LiveClient => {
    if (client.current) return client.current;
    const c = new LiveClient({
      onOpen: () => { set({ phase: "idle", error: undefined, warming: true }); const st = useLiveStore.getState(); client.current?.bind(st.boundAgent, st.boundCwd || undefined, readResume(chatId) || undefined); },
      onReconnecting: () => set({ phase: "reconnecting" }),
      onClose: () => teardown(),
      onError: (m) => set({ error: m, agentConnecting: false }),
      // A session/load recovered prior turns (persisted server-side) — refetch so the
      // resumed transcript renders. preloadIfEmpty so a live turn the user started
      // during the refetch isn't wiped by the replace.
      onReloadHistory: () => { api.messages(chatId).then((m) => chatStore.preloadIfEmpty(chatId, m as never)).catch(() => {}); },
      // A bound agent wants permission: speak the ask and show approve/deny chips.
      // A spoken reminder fires ~30s before the server's auto-deny — a voice-first
      // user may not be looking at the countdown.
      onPermission: (reqId, question, options, expiresAt) => {
        set({ permission: { reqId, question, options, expiresAt } });
        engine.current?.feedAgentDelta(`${question} `);
        // High-stakes while unfocused: an unanswered ask auto-denies in 2 minutes.
        notifyDesktop("Permission needed", question);
        if (permReminder.current) clearTimeout(permReminder.current);
        const remindIn = (expiresAt ?? 0) - Date.now() - 30_000;
        if (remindIn > 0) permReminder.current = setTimeout(() => {
          if (useLiveStore.getState().permission?.reqId === reqId) engine.current?.say("Still waiting on that permission — I'll take it as a no in thirty seconds.");
        }, remindIn);
      },
      // The bound agent reported its selectable models/modes (or a switch landed).
      onAgentMeta: (meta) => {
        const agent = useLiveStore.getState().boundAgent;
        if (agent) { try { localStorage.setItem(`openlive-meta:${agent}`, JSON.stringify(meta)); } catch { /* */ } }
        set({ agentMeta: meta, agentConnecting: false });
        // Apply the remembered model/mode preference now the agent's set is known.
        if (agent) {
          const pm = readPref(`openlive-model:${agent}`);
          if (pm && pm !== meta.currentModelId && meta.models.some((m) => m.id === pm)) client.current?.setModel(pm);
          const pd = readPref(`openlive-mode:${agent}`);
          if (pd && pd !== meta.currentModeId && meta.modes.some((m) => m.id === pd)) client.current?.setMode(pd);
          for (const o of meta.options ?? []) {
            const p = readPref(`openlive-opt:${agent}:${o.id}`);
            if (p && p !== o.currentId && o.values.some((v) => v.id === p)) client.current?.setOption(o.id, p);
          }
        }
      },
      onSse: (e) => {
        // Also clear agentConnecting — a server-sent agent-start failure would
        // otherwise leave the lobby's "Connecting to <agent>…" selects stuck.
        if (e.type === "error") {
          set({ error: e.message, agentConnecting: false });
          // Speak a SHORT version (first sentence, capped) — the full text stays
          // in the banner + hint chip. Voice-first users hear the failure.
          const short = e.message.split(/(?<=[.!?])\s/)[0]?.slice(0, 140);
          if (short) engine.current?.say(short);
          return;
        }
        // Warm-up done → drop the "Warming up…" spinner; the first turn is now hot.
        if (e.type === "status") { if (e.text === "ready") set({ warming: false }); return; }
        // Prose text drives the VOICE only; the chat transcript is filled word-by-word
        // as each chunk is spoken (onAgentText), NOT from the generated stream (which
        // races ahead) — so an interrupt leaves the panel showing only what was said.
        if (e.type === "text_delta") { engine.current?.feedAgentDelta(e.text); return; }
        // Reasoning streams into the transcript's work block (interleaved with tools).
        if (e.type === "reasoning_delta") { if (assistantId.current) chatStore.liveReason(chatId, assistantId.current, e.text); return; }
        if (e.type === "done") {
          set({ toolStatus: "" });
          engine.current?.endAgentTurn();
          // A long-running turn finished while you were in another app (mini-mode
          // workflow) — quick answers don't notify. Main shows it only if unfocused.
          if (turnStartedAt.current && Date.now() - turnStartedAt.current > 5000) {
            notifyDesktop(agentLabel(useLiveStore.getState().boundAgent), "Finished — ready when you are.");
          }
          turnStartedAt.current = 0;
          // Finish the spoken turn but KEEP assistantId pointing at it, so any
          // trailing event still attaches. It rolls forward on the next user turn
          // (handleUserText) and is finalized on teardown.
          if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
          return;
        }
        // Show tool activity LIVE — the moment it starts — so the user gets a real
        // cue (transcript chip + the "Searching the web…" subtitle) WHILE it runs,
        // not bundled in after the answer. toolStatus drives the in-call status line.
        if (e.type === "tool_start") {
          set({ toolStatus: e.tool });
          if (assistantId.current) chatStore.liveEvent(chatId, assistantId.current, e);
          return;
        }
        if (e.type === "tool_done") {
          set({ toolStatus: "" });
          if (assistantId.current) chatStore.liveEvent(chatId, assistantId.current, e);
          return;
        }
        // The agent's working plan (ACP plan updates / update_todos tool). Kept
        // across turns — plans span them; the server sends [] on plan_removed,
        // and teardown clears the store.
        if (e.type === "todos") { set({ todos: e.items }); return; }
        // Context/cost from the latest turn (ACP usage_update or the built-in
        // brain's own accounting).
        if (e.type === "usage") { set({ usage: { contextTokens: e.contextTokens, outputTokens: e.outputTokens, costUsd: e.costUsd } }); return; }
      },
      onNeedFrame: async (reqId) => {
        const st = useLiveStore.getState();
        const src = st.cameraOn ? camRef.current : st.screenOn ? screenRef.current : null;
        if (!src) { client.current?.frameResponse(reqId); return; }
        const jpeg = await src.captureHiRes();
        client.current?.frameResponse(reqId);   // server arms for the look frame FIRST
        if (jpeg) client.current?.sendFrame(jpeg);
      },
      // OS bridge (clipboard / open_url) — runs through the Electron main process.
      // On the web build there's no bridge, so we answer instantly (no dead air).
      onToolBridge: async (reqId, op, arg) => {
        const api = (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive;
        if (!api?.bridge) { client.current?.toolBridgeResult(reqId, "That's only available in the OpenLive desktop app."); return; }
        try { client.current?.toolBridgeResult(reqId, await api.bridge(op, arg)); }
        catch (e: any) { client.current?.toolBridgeResult(reqId, `Couldn't do that: ${String(e?.message ?? e)}`); }
      },
    });
    client.current = c;
    activeLiveClient = c;
    c.connect(chatId);
    onPageHide.current = () => teardown();
    window.addEventListener("pagehide", onPageHide.current);
    return c;
  }, [chatId, set, teardown]);

  // Pre-call: connect a bound agent (with a project folder) so it reports its
  // models/modes into the lobby BEFORE the call starts. No-op for the built-in
  // assistant (its models come from the provider API) or if already connected.
  const prewarm = useCallback(() => {
    const st = useLiveStore.getState();
    if (!st.boundAgent || !st.boundCwd || client.current) return;
    tornDown.current = false;
    set({ agentConnecting: true, agentMeta: null, error: undefined });
    try { ensureClient(); } catch (e: any) { set({ agentConnecting: false, error: `Couldn't connect to ${st.boundAgent}: ${String(e?.message ?? e)}` }); }
  }, [set, ensureClient]);

  const start = useCallback(async () => {
    tornDown.current = false;
    set({ error: undefined, phase: "connecting", active: true, downloadPct: 0, userCaption: "", userPartial: false, agentCaption: "", toolStatus: "", permission: null, agentMeta: null, boundAgent: readBind(chatId), boundCwd: readCwd(chatId) });
    // Unlock audio NOW, synchronously inside the click gesture. iOS Safari blocks
    // AudioContext playback that starts after an await, so priming here (before the
    // model download) is what lets the agent's voice actually play on iPhone.
    if (!player.current) player.current = new AudioPlayer();
    player.current.resume();
    try {
      // 1. Models (download-on-demand, cached). Shows a progress bar the first time.
      if (!modelsReady()) { set({ phase: "loading" }); await loadModels((p) => set({ downloadPct: p.pct, downloadLoaded: p.loaded, downloadTotal: p.total, downloadModels: p.models })); }
      if (tornDown.current) return;

      // Cloned voice: fire-and-forget a tiny synth so the agent-side engine's
      // ~1s cold start happens now, not on the first real reply.
      const ttsCfg = (await import("./pipelineConfig")).loadPipelineConfig().tts;
      if (ttsCfg.engine === "clone" && ttsCfg.voice) {
        void fetch("/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi.", profileId: ttsCfg.voice }) }).catch(() => {});
      }

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
        onPhase: (p: EnginePhase) => set(p === "listening" ? { phase: p, agentCaption: "", toolStatus: "" } : { phase: p }),
        onPartial: (text) => set({ userCaption: text, userPartial: true, warming: false }),
        onUserText: (text) => void handleUserText(text),
        // Mid-thought hold → "waiting for you… tap to send" affordance (null clears it).
        onHold: (h) => set({ holdUntil: h?.until ?? null }),
        // A chunk just STARTED voicing. Drive TWO things from it: the composer
        // subtitle (rolling 3-4 word window — VoiceBar reads agentCaption) AND the
        // chat transcript, which types this chunk word-by-word in lockstep with the
        // audio so the panel shows exactly what's been said (honest on barge-in).
        onAgentText: (sentence, durationMs) => {
          set({ agentCaption: sentence, agentCaptionMs: durationMs });
          const id = assistantId.current;
          // The previous chunk's audio has finished (this one is now playing) — commit
          // it into the current segment.
          if (curChunk.current) segText.current = segText.current ? `${segText.current} ${curChunk.current}` : curChunk.current;
          curChunk.current = sentence;
          stopReveal();
          if (!id) return;
          const words = sentence.split(/\s+/).filter(Boolean);
          const base = segText.current;
          // Hidden window (desktop mini mode): rAF is frozen — write the whole chunk
          // at once instead of animating it.
          if (document.hidden) { chatStore.liveText(chatId, id, base ? `${base} ${sentence}` : sentence); return; }
          const dur = durationMs > 0 ? durationMs : words.length * 320;
          const startedAt = performance.now();
          const step = () => {
            if (id !== assistantId.current) return; // turn moved on
            const frac = Math.min(1, (performance.now() - startedAt) / dur);
            const idx = Math.max(1, Math.min(words.length, Math.ceil(frac * words.length)));
            const revealed = words.slice(0, idx).join(" ");
            chatStore.liveText(chatId, id, base ? `${base} ${revealed}` : revealed);
            if (frac < 1) revealRaf.current = requestAnimationFrame(step);
            else revealRaf.current = null;
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
          set({ toolStatus: "" });
          // Keep what's already revealed (voice-synced ≈ what was spoken); just stop
          // advancing. Commit the current chunk so the next turn starts clean.
          if (curChunk.current) segText.current = segText.current ? `${segText.current} ${curChunk.current}` : curChunk.current;
          curChunk.current = null;
          // Clear any pending permission chip — the server cancels the ask on
          // barge-in, so a lingering approve/deny would just no-op if tapped.
          set({ agentCaption: "", userCaption: "", userPartial: false, permission: null });
        },
      }, player.current ?? undefined);
      engine.current = eng;
      await eng.start(stream);
      if (tornDown.current) return;

      // 4. Socket — reuse the pre-call agent connection if the lobby already opened
      //    it (prewarm), otherwise open it now. The voice engine above drives turns
      //    over whichever connection; a pre-connected agent means Start is instant.
      if (!client.current) set({ phase: "connecting" });
      const c = ensureClient();
      if (c.ready) set({ phase: "idle", warming: false, error: undefined }); // already connected in the lobby
      await refreshDevices();
    } catch (e: any) {
      const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      set({ error: denied ? "Microphone access denied. Allow the mic and try again." : `Couldn't start live mode: ${String(e?.message ?? e)}` });
      teardown();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, set, teardown, ensureClient]);

  // Answer a bound agent's pending permission ask (chip tap or classified voice).
  const answerPermission = useCallback((optionId: string) => {
    const p = useLiveStore.getState().permission;
    if (!p) return;
    if (permReminder.current) { clearTimeout(permReminder.current); permReminder.current = null; }
    client.current?.permissionResponse(p.reqId, optionId);
    set({ permission: null });
  }, [set]);


  // Reflect this conversation's saved agent + project folder in the store when it
  // opens, so the pre-call pickers show the right values before the call starts.
  useEffect(() => { set({ boundAgent: readBind(chatId), boundCwd: readCwd(chatId), agentMeta: null }); }, [chatId, set]);

  // Push an agent OR folder change to the server whenever it flips during an active
  // call (the initial bind is also sent on socket open). Idle changes persist locally.
  useEffect(() => {
    if (!client.current?.ready) return;
    // A bound agent's models/modes are agent-specific — clear + re-fetch on a switch.
    set({ agentMeta: null, agentConnecting: !!boundAgent && !!boundCwd });
    client.current.bind(boundAgent, boundCwd || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundAgent, boundCwd]);

  // A completed user turn: attach the freshest camera frame, send the text, and
  // reflect the exchange in the chat store (so it renders + persists like typing).
  const handleUserText = useCallback(async (text: string) => {
    // While an agent permission is pending, the next utterance IS the answer — a
    // spoken yes/no, not a new turn. Ambiguous replies are ignored (keep waiting).
    const pend = useLiveStore.getState().permission;
    if (pend) {
      const yn = classifyYesNo(text);
      set({ userCaption: "", userPartial: false });
      if (yn) answerPermission(yn === "allow" ? (pend.options.find((o) => o.id === "allow")?.id ?? pend.options.find((o) => o.id === "always")?.id ?? "deny") : "deny");
      return;
    }
    // Attach the freshest frame from every active visual source (camera + screen
    // can both be on), inline with the turn so the model sees exactly this moment.
    const st0 = useLiveStore.getState();
    const frames: { data: string; mime: string; source: "camera" | "screen" }[] = [];
    if (st0.cameraOn && camRef.current) { const j = await camRef.current.captureFreshest(); if (j) frames.push({ data: abToBase64(j), mime: "image/jpeg", source: "camera" }); }
    if (st0.screenOn && screenRef.current) { const j = await screenRef.current.captureFreshest(); if (j) frames.push({ data: abToBase64(j), mime: "image/jpeg", source: "screen" }); }
    client.current?.userText(text, frames);
    turnStartedAt.current = Date.now();
    set({ userCaption: "", userPartial: false, agentCaption: "" });
    if (assistantId.current) chatStore.liveFinish(chatId, assistantId.current);
    resetTranscript(); // new turn → the word reveal starts fresh (don't carry prior spoken text)
    assistantId.current = chatStore.liveUserTurn(chatId, text);
  }, [chatId, set, answerPermission]);

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

  // Change the mic — live if a call is active (rebuild the stream + VAD), else it
  // just applies on the next start. `id` "" = system default.
  const setMic = useCallback(async (id: string) => {
    set({ micId: id || undefined });
    if (!useLiveStore.getState().active || !engine.current) return;
    try {
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (id) audio.deviceId = { exact: id };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const old = micStream.current;
      micStream.current = stream;
      await engine.current.setStream(stream);
      old?.getTracks().forEach((t) => t.stop()); // stop the previous mic only after the swap
    } catch { set({ error: "Couldn't switch microphone." }); }
  }, [set]);

  // Devices coming and going mid-call: refresh the pickers, and if the ACTIVE mic
  // was unplugged, fall back to the system default so the call keeps listening.
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    const onChange = async () => {
      await refreshDevices();
      const st = useLiveStore.getState();
      if (!st.active || !st.micId) return;
      try {
        const devs = await md.enumerateDevices();
        if (!devs.some((d) => d.kind === "audioinput" && d.deviceId === st.micId)) {
          toast("Microphone disconnected — switched to the default mic.", "info");
          await setMic("");
        }
      } catch { /* enumerate unavailable */ }
    };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [refreshDevices, setMic]);

  const setCam = useCallback(async (id: string) => {
    set({ camId: id });
    if (camRef.current && useLiveStore.getState().cameraOn) {
      camRef.current.stop();
      const c = new CameraCapture();
      camRef.current = c;
      try { await c.start(id); set({ cameraStream: c.getStream() ?? null }); }
      catch { camRef.current = null; set({ error: "Couldn't switch camera.", cameraStream: null }); }
    }
  }, [set]);

  const toggleCamera = useCallback(async () => {
    const on = !useLiveStore.getState().cameraOn;
    if (on) {
      const camera = new CameraCapture();
      camRef.current = camera;
      try {
        await camera.start(useLiveStore.getState().camId);
        await refreshDevices();
      } catch {
        try { camera.stop(); } catch { /* */ }
        camRef.current = null;
        set({ error: "Camera access denied." });
        return;
      }
      client.current?.control("camera_on");
      set({ cameraOn: true, cameraStream: camera.getStream() ?? null });
    } else {
      client.current?.control("camera_off");
      camRef.current?.stop();
      camRef.current = null;
      set({ cameraOn: false, cameraStream: null });
    }
  }, [set, refreshDevices]);

  // Share a screen/window — independent of the camera (both can be on). The
  // model sees the shared screen through the same inline-frame pipeline.
  const toggleScreen = useCallback(async () => {
    const on = !useLiveStore.getState().screenOn;
    if (on) {
      const cap = new CameraCapture();
      screenRef.current = cap;
      try {
        await cap.startScreen(() => {
          client.current?.control("screen_off");
          try { screenRef.current?.stop(); } catch { /* */ }
          screenRef.current = null;
          set({ screenOn: false, screenStream: null });
        });
      } catch {
        try { cap.stop(); } catch { /* */ }
        screenRef.current = null;
        set({ error: "Screen share was cancelled." });
        return;
      }
      client.current?.control("screen_on");
      set({ screenOn: true, screenStream: cap.getStream() ?? null });
    } else {
      client.current?.control("screen_off");
      screenRef.current?.stop();
      screenRef.current = null;
      set({ screenOn: false, screenStream: null });
    }
  }, [set]);

  const getLevels = useCallback(() => ({ mic: engine.current?.micLevel() ?? 0, agent: engine.current?.agentLevel() ?? 0 }), []);
  // Per-frequency-band energy (0..1) of the live voice — drives the orb's real
  // reactive spectrum while you or the agent talk.
  const getBands = useCallback(() => ({ mic: engine.current?.micBands() ?? NO_BANDS, agent: engine.current?.agentBands() ?? NO_BANDS }), []);

  // "Send now": commit a held mid-thought utterance instead of waiting out the hold.
  const sendNow = useCallback(() => engine.current?.commitPending(), []);
  // Push-to-talk: hold = accumulate speech with auto end-of-turn suspended; release = the turn.
  const pttDown = useCallback(() => { if (!engine.current) return; engine.current.beginPtt(); set({ pttActive: true }); }, [set]);
  const pttUp = useCallback(() => { const e = engine.current; if (!e) return; set({ pttActive: false }); void e.endPtt(); }, [set]);

  return { start, stop, prewarm, download, toggleMute, toggleCamera, toggleScreen, getLevels, getBands, refreshDevices, setMic, setCam, answerPermission, sendNow, pttDown, pttUp };
}
