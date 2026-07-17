"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { useLiveStore } from "@/lib/live/liveStore";
import { useLiveSession } from "@/lib/live/useLiveSession";
import { usePtt } from "@/lib/live/usePtt";
import { useUi } from "@/lib/uiStore";
import { api } from "@/lib/api";
import { chatStore } from "@/lib/chatStore";
import { Lobby } from "./Lobby";
import { InCall } from "./InCall";
import { MiniBar } from "./MiniBar";
import { PanelBridge } from "./PanelBridge";
import { PermissionPrompt } from "./AgentControls";
import { ElicitationPrompt } from "./ElicitationPrompt";
import { isDesktop } from "@/lib/platform";

// Hosts one live call: a full-page lobby before the call (self-preview, agent /
// model pick, devices, model download) then the full-screen in-call view — both
// share the same TopBar + main + sidebar skeleton so the switch feels continuous.
export function LiveDock({ chatId, onExit }: { chatId: string; onExit: () => void }) {
  const { start, stop, prewarm, download, toggleMute, toggleCamera, toggleScreen, getLevels, getBands, refreshDevices, setMic, setCam, answerPermission, sendNow, pttDown, pttUp } = useLiveSession(chatId);
  // Narrow selector: this component must NOT subscribe to the hot per-chunk
  // fields (captions, toolStatus, todos, usage, terminals) — InCall and
  // TranscriptPanel own those. Whole-store destructuring made the entire call
  // UI re-render on every caption tick.
  const { active, phase, modelsDownloaded, downloading, downloadPct, downloadLoaded, downloadTotal, downloadModels, muted, cameraOn, screenOn, cameraStream, screenStream, error, mics, cams, micId, camId, boundAgent, boundCwd } = useLiveStore(useShallow((s) => ({
    active: s.active, phase: s.phase, modelsDownloaded: s.modelsDownloaded, downloading: s.downloading,
    downloadPct: s.downloadPct, downloadLoaded: s.downloadLoaded, downloadTotal: s.downloadTotal, downloadModels: s.downloadModels,
    muted: s.muted, cameraOn: s.cameraOn, screenOn: s.screenOn, cameraStream: s.cameraStream, screenStream: s.screenStream,
    error: s.error, mics: s.mics, cams: s.cams, micId: s.micId, camId: s.camId, boundAgent: s.boundAgent, boundCwd: s.boundCwd,
  })));
  const openSettings = useUi((s) => s.openSettings);
  const minimized = useUi((s) => s.minimized);
  const setMinimized = useUi((s) => s.setMinimized);

  // Hold Space = push-to-talk, Enter = send a held pause now; the desktop mini
  // pill's global hotkey arrives as a toggle through the same hook.
  usePtt(active, { pttDown, pttUp, sendNow });

  useEffect(() => { void refreshDevices(); }, [refreshDevices]);
  // Preload a resumed conversation's transcript from the saved store.
  useEffect(() => { api.messages(chatId).then((m) => chatStore.preload(chatId, m as never)).catch(() => {}); }, [chatId]);
  useEffect(() => () => stop(), [stop]);

  // Only warm up an agent that can actually start. Prewarming an uninstalled or
  // signed-out agent spawns a binary that isn't there and dumps its raw failure
  // ("spawn hermes-acp ENOENT") into the lobby — next to the Start button already
  // explaining the real problem. `undefined` while the probe is in flight means we
  // hold off one tick rather than spawn on a guess.
  const { data: agentRows } = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: !!boundAgent });
  const agentRow = boundAgent ? agentRows?.find((r) => r.id === boundAgent) : undefined;
  const agentReady = !!agentRow?.installed && agentRow.credState !== "login_required";

  // Pre-call: connect a bound coding agent as soon as it has a project folder, so it
  // reports its models/modes into the lobby before the call starts (and Start is
  // instant). No-op for the built-in assistant or once already connected.
  useEffect(() => { if (!active && boundAgent && boundCwd && agentReady) prewarm(); }, [active, boundAgent, boundCwd, agentReady, prewarm]);

  const end = () => { setMinimized(false); stop(); onExit(); };

  return (
    <>
      {!active && (
        <Lobby mics={mics} cams={cams} micId={micId} camId={camId} onMic={(id) => void setMic(id)} onCam={setCam}
          error={error} modelsDownloaded={modelsDownloaded} downloading={downloading} downloadPct={downloadPct}
          downloadLoaded={downloadLoaded} downloadTotal={downloadTotal} downloadModels={downloadModels}
          refreshDevices={refreshDevices} onDownload={() => void download()} onStart={() => void start()}
          onOpenSettings={openSettings} onExit={end} />
      )}

      {/* Desktop mini = a separate always-on-top panel window (this window hides);
          web mini = the in-page pill overlay. */}
      {active && minimized && isDesktop && (
        <PanelBridge toggleMute={toggleMute} toggleCamera={toggleCamera} toggleScreen={toggleScreen}
          onEnd={end} sendNow={sendNow} answerPermission={answerPermission} getBands={getBands} />
      )}
      {active && minimized && !isDesktop && (
        <MiniBar phase={phase} muted={muted} cameraOn={cameraOn} screenOn={screenOn}
          cameraStream={cameraStream} screenStream={screenStream}
          toggleMute={toggleMute} toggleCamera={toggleCamera} toggleScreen={toggleScreen}
          getLevels={getLevels} getBands={getBands} onEnd={end} sendNow={sendNow} />
      )}
      {active && !minimized && (
        <InCall chatId={chatId} phase={phase} muted={muted} cameraOn={cameraOn} screenOn={screenOn} pttUp={pttUp}
          cameraStream={cameraStream} screenStream={screenStream} error={error}
          toggleMute={toggleMute} toggleCamera={toggleCamera} toggleScreen={toggleScreen}
          setMic={(id) => void setMic(id)} setCam={setCam}
          getLevels={getLevels} getBands={getBands} onEnd={end} sendNow={sendNow} />
      )}
      {active && <PermissionPrompt answerPermission={answerPermission} />}
      {active && <ElicitationPrompt />}
    </>
  );
}
