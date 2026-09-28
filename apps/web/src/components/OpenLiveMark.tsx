"use client";

import { OpenLiveOrb } from "./OpenLiveOrb";

// The OpenLive home mark: the shared wave orb as the logo, live.
// One mark everywhere (home hero, top bar, in-call orb) so the brand reads as a
// single living object.
export function OpenLiveMark({ size = 84, paused }: { size?: number; paused?: boolean }) {
  return <OpenLiveOrb size={size} pulse paused={paused} />;
}
