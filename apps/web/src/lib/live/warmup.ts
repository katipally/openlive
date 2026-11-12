"use client";

import { listNativeEngines, loadModels, modelsCached, modelsReady } from "./models";
import { DEFAULT_PIPELINE_CONFIG, nativeFirst, savePipelineConfig } from "./pipelineConfig";
import { useVoicePrefs } from "../prefs";
import { log } from "@/lib/log";

// Warm the voice stack in the background right after launch so the FIRST call
// starts instantly: load the already-downloaded models (compiles WebGPU shaders)
// and spin the mic driver once. Strictly quiet — it never triggers a permission
// prompt and never downloads weights that weren't already fetched.
let warmed = false;

export function warmupOnLaunch(): void {
  if (warmed || typeof window === "undefined") return;
  // Flow's orb window is a display-only renderer: the main window and Flow's
  // owner renderer hold the voice stack, and warming in the orb would load a
  // duplicate copy of every model.
  if (window.location.pathname === "/flow") return;
  warmed = true;
  // Let first paint + hydration settle before grabbing CPU/GPU for shaders.
  setTimeout(() => { void seedNativeDefaults().then(run); warmOcr(); }, 1500);
}

// A machine with no usable WebGPU adapter (navigator.gpu alone can exist
// without one) runs the browser models on WASM, ~10x slower than the agent's
// native tier, so the first launch's engines become the downloaded native ones.
// Only while nothing is saved: any engine the user picked is in that saved config.
async function seedNativeDefaults(): Promise<void> {
  try {
    if (useVoicePrefs.getState().pipeline) return;
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (await gpu?.requestAdapter().catch(() => null)) return;
    const families = await listNativeEngines(AbortSignal.timeout(3000));
    if (useVoicePrefs.getState().pipeline) return;
    const installed = new Set(families.flatMap((f) => f.variants.filter((v) => v.installed && v.runnable).map((v) => v.id)));
    const next = nativeFirst(DEFAULT_PIPELINE_CONFIG, { webgpu: false, installed });
    if (next !== DEFAULT_PIPELINE_CONFIG) savePipelineConfig(next);
  } catch (e) { log.debug("warmup", "native defaults skipped:", e); }
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
    await loadModels(() => {}, "launch_warm"); // weights come from the Cache API; this is shader warm-up
    log.debug("warmup", "voice stack warmed before first call");
  } catch (e) { log.debug("warmup", "skipped:", e); }
}

/** The OS text recogniser costs tens of seconds the first time a process asks
 *  it anything. Paying that on a blank tile at launch is what keeps the first
 *  real question about the screen from looking like a hang. Needs no
 *  permission: it reads a bitmap we made, not the screen. */
function warmOcr(): void {
  const flow = (window as { openlive?: { flow?: { warmOcr?: () => Promise<unknown> } } }).openlive?.flow;
  void flow?.warmOcr?.().catch(() => {});
}
