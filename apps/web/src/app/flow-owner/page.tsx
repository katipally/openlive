"use client";

import { useFlowOwner } from "@/lib/flow/useFlowOwner";

// The hidden renderer that owns Flow: the microphone, the voice cascade, the
// Flow socket and every decision. It is never shown, so it paints nothing.
export default function FlowOwnerPage() {
  useFlowOwner();
  return null;
}
