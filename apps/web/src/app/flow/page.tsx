"use client";

import { useEffect } from "react";
import { FlowOrb } from "@/components/flow/FlowOrb";

// Flow's orb window loads this route. Pure display surface: everything it shows
// arrives over IPC, from the owner renderer or, for a call, the main process.
export default function FlowPage() {
  // globals.css strips the root chrome that would otherwise paint behind a
  // chromeless floating orb.
  useEffect(() => {
    document.documentElement.classList.add("chromeless");
    return () => document.documentElement.classList.remove("chromeless");
  }, []);
  return <FlowOrb />;
}
