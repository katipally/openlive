"use client";

import { loadModels, modelsCached, modelsReady } from "./models";
import { log } from "@/lib/log";

// Warm the voice stack in the background right after launch so the FIRST call
// starts instantly: load the already-downloaded models (compiles WebGPU shaders)
// and spin the mic driver once. Strictly quiet — it never triggers a permission
// prompt and never downloads weights that weren't already fetched.
let warmed = false;

export function warmupOnLaunch(): void {
  if (warmed || typeof window === "undefined") return;
  // The desktop mini panel is its own renderer — the MAIN window owns the voice
  // stack; warming here would load a duplicate copy of every model.
  if (window.location.pathname.startsWith("/mini")) return;
  warmed = true;
  // Let first paint + hydration settle before grabbing CPU/GPU for shaders.
  setTimeout(() => { void run(); }, 1500);
}

async function run(): Promise<void> {
  if (!modelsCached() || modelsReady()) return; // nothing cached yet, or already warm
  try {
    // Mic driver spin-up ONLY if permission is already granted (no prompt).
    const perm = await navigator.permissions?.query?.({ name: "microphone" as PermissionName }).catch(() => null);
    if (perm?.state === "granted") {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        setTimeout(() => s.getTracks().forEach((t) => t.stop()), 250);
      } catch { /* device busy — the call will grab it */ }
    }
    await loadModels(() => {}); // weights come from the Cache API; this is shader warm-up
    log.debug("warmup", "voice stack warmed before first call");
  } catch (e) { log.debug("warmup", "skipped:", e); }
}
