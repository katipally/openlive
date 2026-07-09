// Curated "best for Live voice" model shortlist, per provider. Live mode wants
// FAST time-to-first-token + short spoken replies. This is a hand-picked
// convenience layer over each provider's full model list (still fetched live) —
// NOT an allowlist and NOT a gate. `vision` is a hint for the picker badge only;
// frames are attached regardless and the model/provider decides what it can do.
export interface LiveModelRec {
  model: string;       // provider model id (what gets stored as `liveModel`)
  label: string;       // short human label for the chip
  note: string;        // why it's good for live
  vision: boolean;     // hint for the picker badge (does it take image input?)
  default?: boolean;   // the ✦ pick for this provider
}

export const LIVE_MODEL_RECS: Record<string, LiveModelRec[]> = {
  anthropic: [
    { model: "claude-haiku-4-5", label: "Haiku 4.5", note: "~600ms first token, vision, natural short replies", vision: true, default: true },
  ],
  openai: [
    { model: "gpt-5-mini", label: "GPT-5 mini", note: "fast, multimodal, cheap", vision: true, default: true },
    { model: "gpt-5-nano", label: "GPT-5 nano", note: "lowest latency", vision: true },
  ],
  minimax: [
    { model: "MiniMax-M2.5-highspeed", label: "M2.5 highspeed", note: "fast, strong tool use", vision: true, default: true },
    { model: "MiniMax-M3", label: "M3", note: "1M context, multimodal", vision: true },
  ],
};

/** Recommended live models for a provider (empty if none curated). */
export function liveRecsFor(providerId: string): LiveModelRec[] {
  return LIVE_MODEL_RECS[providerId] ?? [];
}

/** Best-effort hint of whether a model takes image input — used only for the
 *  picker's vision badge. NOT a gate: frames are attached regardless and the
 *  provider surfaces a real error if it genuinely can't take them (never faked).
 *  Optimistic by default so we don't wrongly bias against capable models. */
export function modelVision(providerId: string, model: string): boolean {
  const rec = LIVE_MODEL_RECS[providerId]?.find((r) => r.model === model);
  if (rec) return rec.vision;
  // Known text/embedding-only families → no image badge; everything else assumed
  // multimodal (most current chat models are).
  if (/embed|whisper|tts|moderation|^text-|o1-mini|o3-mini/i.test(model)) return false;
  return true;
}
