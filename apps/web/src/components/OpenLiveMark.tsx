"use client";

import { OpenLiveOrb } from "./OpenLiveOrb";

// The OpenLive home mark: the shared carved-waveform orb with a gentle idle pulse.
// One mark everywhere (home hero, top bar, favicon, in-call orb) so the brand reads
// as a single living object.
export function OpenLiveMark({ size = 84 }: { size?: number }) {
  return <OpenLiveOrb size={size} pulse />;
}
