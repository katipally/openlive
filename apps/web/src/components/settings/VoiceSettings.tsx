"use client";

import { useEffect, useState } from "react";
import { loadPipelineConfig, savePipelineConfig, onPipelineConfig } from "@/lib/live/pipelineConfig";
import { PipelineSettings, LanguagePicker } from "./PipelineSettings";
import { VoicesSettings } from "./VoicesSettings";
import { Section } from "./Section";

/** Speaking speed for all TTS engines, stored in the pipeline config (same
 *  store the Text-to-speech stage reads); applies from the next reply. */
function SpeakingSpeed() {
  const [cfg, setCfg] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setCfg), []);
  const set = (v: number) => setCfg(savePipelineConfig({ ...cfg, tts: { ...cfg.tts, speed: v } }));
  return (
    <label className="flex max-w-md flex-col gap-1.5">
      <span className="flex items-center justify-between text-label text-foreground">Speaking speed<span className="tabular-nums text-muted-foreground">{cfg.tts.speed.toFixed(2)}×</span></span>
      <input type="range" min={0.5} max={2} step={0.05} value={cfg.tts.speed} onChange={(e) => set(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
    </label>
  );
}

// One home for everything about how OpenLive hears and speaks: the language
// first (every stage below follows it), then speed (the knob people reach for
// most), then the on-device engine, then cloned voices.
export function VoiceSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-voice-language" title="Language" desc="What you speak and what OpenLive answers in. Transcription, the voice and the reply all follow it.">
        <LanguagePicker />
      </Section>
      <Section id="set-voice-speaking" title="Speaking" desc="How fast replies are read out, whichever voice is speaking.">
        <SpeakingSpeed />
      </Section>
      <Section id="set-voice-engine" title="Speech engine" desc="Voice detection, transcription, turn-taking and the voice that answers.">
        <PipelineSettings />
      </Section>
      <div id="set-voice-yours">
        <VoicesSettings />
      </div>
    </div>
  );
}
