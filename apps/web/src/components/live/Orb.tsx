"use client";

// The in-call voice orb is the shared OpenLive mark (a glass orb with a spectral
// wave inside), driven live by mic/agent level. Kept as a thin re-export so
// existing call sites (InCall, FlowOrb) don't change.
export { OpenLiveOrb as Orb } from "@/components/OpenLiveOrb";
