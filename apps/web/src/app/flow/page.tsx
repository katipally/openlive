"use client";

import { useEffect } from "react";
import { FlowPill } from "@/components/flow/FlowPill";

// Flow's pill window loads this route. Pure display surface: everything it shows
// arrives over IPC from the owner renderer.
export default function FlowPage() {
  // Same tag the mini panel uses, so globals.css strips the root chrome that
  // would otherwise paint behind a chromeless floating pill.
  useEffect(() => {
    document.documentElement.classList.add("mini");
    return () => document.documentElement.classList.remove("mini");
  }, []);
  return <FlowPill />;
}
