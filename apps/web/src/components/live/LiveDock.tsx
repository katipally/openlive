"use client";

import { useEffect } from "react";
import { useLiveStore } from "@/lib/live/liveStore";
import { useLiveSession } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";
import { api } from "@/lib/api";
import { chatStore } from "@/lib/chatStore";
import { Lobby } from "./Lobby";
import { InCall } from "./InCall";
import { MiniBar } from "./MiniBar";
import { PermissionPrompt } from "./AgentControls";

// Hosts one live call: a full-page lobby before the call (self-preview, agent /
// model pick, devices, model download) then the full-screen in-call view — both
// share the same TopBar + main + sidebar skeleton so the switch feels continuous.
export function LiveDock({ chatId, onExit }: { chatId: string; onExit: () => void }) {
  const { start, stop, download, toggleMute, toggleCamera, toggleScreen, getLevels, getBands, refreshDevices, setMic, setCam, answerPermission } = useLiveSession(chatId);
  const { active, phase, modelsDownloaded, downloading, downloadPct, downloadLoaded, downloadTotal, downloadModels, muted, cameraOn, screenOn, cameraStream, screenStream, error, mics, cams, micId, camId } = useLiveStore();
  const openSettings = useUi((s) => s.openSettings);
  const minimized = useUi((s) => s.minimized);
  const setMinimized = useUi((s) => s.setMinimized);

  useEffect(() => { void refreshDevices(); }, [refreshDevices]);
  // Preload a resumed conversation's transcript from the saved store.
  useEffect(() => { api.messages(chatId).then((m) => chatStore.preload(chatId, m as never)).catch(() => {}); }, [chatId]);
  useEffect(() => () => stop(), [stop]);

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

      {active && minimized && (
        <MiniBar phase={phase} muted={muted} cameraOn={cameraOn} screenOn={screenOn}
          cameraStream={cameraStream} screenStream={screenStream}
          toggleMute={toggleMute} toggleCamera={toggleCamera} toggleScreen={toggleScreen}
          getLevels={getLevels} getBands={getBands} onEnd={end} />
      )}
      {active && !minimized && (
        <InCall chatId={chatId} phase={phase} muted={muted} cameraOn={cameraOn} screenOn={screenOn}
          cameraStream={cameraStream} screenStream={screenStream} error={error}
          toggleMute={toggleMute} toggleCamera={toggleCamera} toggleScreen={toggleScreen}
          setMic={(id) => void setMic(id)} setCam={setCam}
          getLevels={getLevels} getBands={getBands} onEnd={end} />
      )}
      {active && <PermissionPrompt answerPermission={answerPermission} />}
    </>
  );
}
