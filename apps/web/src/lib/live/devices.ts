"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeviceOpt } from "./liveStore";

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";

const NOUN: Record<DeviceKind, string> = { audioinput: "Microphone", audiooutput: "Speaker", videoinput: "Camera" };

/** Chromium lists the system default twice more under these ids, which "System default" already covers. */
const ALIASES = new Set(["default", "communications"]);

/** The devices of one kind. A label is empty until mic access is granted, so it is numbered instead. */
export function deviceOptions(devs: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[], kind: DeviceKind): DeviceOpt[] {
  return devs.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${NOUN[kind]} ${i + 1}` }));
}

/** The picker's choices: the system default, then every real device. */
export function withDefault(opts: DeviceOpt[]): DeviceOpt[] {
  return [{ id: "", label: "System default" }, ...opts.filter((o) => o.id && !ALIASES.has(o.id))];
}

/** A saved pick that is no longer plugged in is the system default. */
export const pickedDevice = (opts: DeviceOpt[], saved: string): string => (opts.some((o) => o.id === saved) ? saved : "");

/** Microphones and speakers, kept current as devices come and go. `named` is false until the browser reveals labels. */
export function useDevices() {
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let live = true;
    const read = () => void md.enumerateDevices().then((d) => { if (live) setDevs(d); }).catch(() => {});
    read();
    md.addEventListener("devicechange", read);
    return () => { live = false; md.removeEventListener("devicechange", read); };
  }, []);
  return useMemo(() => ({
    mics: withDefault(deviceOptions(devs, "audioinput")),
    speakers: withDefault(deviceOptions(devs, "audiooutput")),
    named: devs.some((d) => d.label),
  }), [devs]);
}
