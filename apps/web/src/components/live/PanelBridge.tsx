"use client";

import { useEffect, useRef } from "react";
import { useLiveStore } from "@/lib/live/liveStore";
import { loadPipelineConfig } from "@/lib/live/pipelineConfig";
import { openliveBridge, setPanelCmdHandler, type PanelStateSnapshot } from "@/lib/live/panelBridge";
import { useUi } from "@/lib/uiStore";
import { savedMiniHotkey } from "@/lib/platform";

// Desktop mini mode. The main window HIDES (its renderer keeps running the whole
// voice pipeline) and a separate always-on-top panel window shows the pill UI.
// This invisible component is the main-renderer half of that bridge: it publishes
// live state to the panel and executes the panel's control commands.

// Grab ~10 fps JPEG snapshots off a MediaStream (previews can't cross windows
// live). Downscaled + mid-quality JPEG keeps each frame ~10-20 KB, so the IPC
// relay stays cheap while the preview reads as motion instead of a slideshow.
class Snap {
  private video = document.createElement("video");
  private canvas = document.createElement("canvas");
  constructor() { this.video.muted = true; this.video.playsInline = true; }
  setStream(s: MediaStream | null) {
    if (this.video.srcObject === s) return;
    this.video.srcObject = s;
    if (s) void this.video.play().catch(() => { /* autoplay-safe: muted */ });
  }
  grab(maxW: number): string | undefined {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!this.video.srcObject || !vw || !vh) return undefined;
    const w = Math.min(maxW, vw), h = Math.round((vh / vw) * w);
    this.canvas.width = w; this.canvas.height = h;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(this.video, 0, 0, w, h);
    return this.canvas.toDataURL("image/jpeg", 0.6);
  }
}

export interface PanelBridgeProps {
  toggleMute: () => void;
  toggleCamera: () => void | Promise<void>;
  toggleScreen: () => void | Promise<void>;
  onEnd: () => void;
  sendNow: () => void;
  answerPermission: (optionId: string) => void;
  getBands: () => { mic: number[]; agent: number[] };
}

export function PanelBridge(props: PanelBridgeProps) {
  const setMinimized = useUi((s) => s.setMinimized);
  // Commands subscribe ONCE (the preload replaces listeners on re-subscribe); the
  // latest props are read through a ref so handlers never go stale.
  const p = useRef(props); p.current = props;

  // Mount = enter panel mode (hide main window, show panel); unmount = restore.
  // The saved global talk hotkey goes first so the main process registers the
  // user's choice (not the default) when the panel comes up.
  useEffect(() => {
    (openliveBridge() as unknown as { setMiniHotkey?: (a: string) => Promise<unknown> } | undefined)?.setMiniHotkey?.(savedMiniHotkey())?.catch?.(() => {});
    openliveBridge()?.mini?.();
    return () => openliveBridge()?.unmini?.();
  }, []);

  // Store state → panel, on every change (cheap: small JSON).
  useEffect(() => {
    const publish = () => {
      const s = useLiveStore.getState();
      const snap: PanelStateSnapshot = {
        phase: s.phase, muted: s.muted, cameraOn: s.cameraOn, screenOn: s.screenOn,
        userCaption: s.userCaption, userPartial: s.userPartial, agentCaption: s.agentCaption,
        toolStatus: s.toolStatus, warming: s.warming, pttActive: s.pttActive,
        holdUntil: s.holdUntil, holdMs: loadPipelineConfig().turn.holdMs, permission: s.permission,
      };
      openliveBridge()?.panelState?.({ k: "s", s: snap });
    };
    publish(); // panel may mount after us — it also gets fresh packets on every change below
    return useLiveStore.subscribe(publish);
  }, []);

  // Orb spectrum ~15 fps (setInterval, NOT rAF — this window is hidden).
  useEffect(() => {
    const t = setInterval(() => {
      const b = p.current.getBands();
      openliveBridge()?.panelState?.({ k: "b", mic: b.mic, agent: b.agent });
    }, 66);
    return () => clearInterval(t);
  }, []);

  // Preview snapshots at ~10 fps (setInterval, NOT rAF — this window is hidden;
  // backgroundThrottling is off, so timers and video decoding keep running).
  useEffect(() => {
    const cam = new Snap(), scr = new Snap();
    const t = setInterval(() => {
      const s = useLiveStore.getState();
      cam.setStream(s.cameraOn ? s.cameraStream : null);
      scr.setStream(s.screenOn ? s.screenStream : null);
      if (!s.cameraOn && !s.screenOn) return;
      openliveBridge()?.panelState?.({
        k: "f",
        cam: s.cameraOn ? cam.grab(430) : undefined,
        screen: s.screenOn ? scr.grab(430) : undefined,
      });
    }, 100);
    return () => clearInterval(t);
  }, []);

  // Panel commands → the live session, via the module router (single listener;
  // the router's fallback keeps expand/end working when this isn't mounted).
  useEffect(() => {
    setPanelCmdHandler((c) => {
      const q = p.current;
      switch (c.t) {
        case "mute": q.toggleMute(); break;
        case "camera": void q.toggleCamera(); break;
        case "screen": void q.toggleScreen(); break;
        case "end": q.onEnd(); break;
        case "expand": setMinimized(false); break;
        case "sendNow": q.sendNow(); break;
        case "permission": q.answerPermission(c.optionId); break;
        default: break;
      }
    });
    return () => setPanelCmdHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
