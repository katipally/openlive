"use client";

import { useState } from "react";
import { AudioWaveform, Mic, Gauge, RotateCcw, Languages } from "lucide-react";
import {
  loadPipelineConfig, savePipelineConfig, KOKORO_VOICES, DEFAULT_PIPELINE_CONFIG,
  WHISPER_SIZES, TURN_ENGINES, type PipelineConfig,
} from "@/lib/live/pipelineConfig";

// A titled section (mirrors ModelsSettings' layout).
function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">{icon}{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5 flex flex-col gap-3.5">{children}</div>
    </section>
  );
}

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[12.5px] text-foreground">
        {label}<span className="tabular-nums text-muted-foreground">{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
    </label>
  );
}

export function PipelineSettings() {
  const [cfg, setCfg] = useState<PipelineConfig>(() => loadPipelineConfig());

  // Persist on every change (localStorage) and clamp via savePipelineConfig.
  const update = (next: PipelineConfig) => setCfg(savePipelineConfig(next));
  const set = <K extends keyof PipelineConfig>(k: K, v: PipelineConfig[K]) => update({ ...cfg, [k]: v });

  return (
    <div className="flex flex-col gap-7">
      <Section icon={<AudioWaveform className="size-4" />} title="Voice (Kokoro)"
        desc="Runs fully on-device — your audio never leaves the machine. Voice and speed apply to the next reply.">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-foreground">Voice</span>
          <select value={cfg.tts.voice} onChange={(e) => set("tts", { ...cfg.tts, voice: e.target.value })}
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy">
            {(["American", "British"] as const).map((accent) => (
              <optgroup key={accent} label={accent}>
                {KOKORO_VOICES.filter((v) => v.accent === accent).map((v) => (
                  <option key={v.id} value={v.id}>{v.name} · {v.gender}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <Slider label="Speaking speed" value={cfg.tts.speed} min={0.5} max={2} step={0.05}
          fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => set("tts", { ...cfg.tts, speed: v })} />
      </Section>

      <Section icon={<Languages className="size-4" />} title="Speech recognition (Whisper)"
        desc="On-device, English-only. Larger is more accurate but downloads more and runs slower. Applies when you next start a conversation.">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-foreground">Model size</span>
          <select value={cfg.stt.whisperSize} onChange={(e) => set("stt", { whisperSize: e.target.value as PipelineConfig["stt"]["whisperSize"] })}
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy">
            {WHISPER_SIZES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </Section>

      <Section icon={<Gauge className="size-4" />} title="Turn-taking"
        desc="How OpenLive decides you've finished speaking. Smart-Turn reads the semantics of your last words; silence timeout just waits out the trailing pause.">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-foreground">Detector</span>
          <select value={cfg.turn.engine} onChange={(e) => set("turn", { ...cfg.turn, engine: e.target.value as PipelineConfig["turn"]["engine"] })}
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy">
            {TURN_ENGINES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {cfg.turn.engine === "smart-turn" && (
          <Slider label="End-of-turn threshold" value={cfg.turn.threshold} min={0} max={1} step={0.05}
            fmt={(v) => v.toFixed(2)} onChange={(v) => set("turn", { ...cfg.turn, threshold: v })} />
        )}
      </Section>

      <Section icon={<Mic className="size-4" />} title="Microphone (Silero VAD)"
        desc="Applies when you next start a conversation. Sensitivity: lower picks up softer speech and barges in faster. Trailing silence: how long a pause runs before your turn ends.">
        <Slider label="Speech sensitivity" value={cfg.vad.speechThreshold} min={0.1} max={0.9} step={0.05}
          fmt={(v) => v.toFixed(2)} onChange={(v) => set("vad", { ...cfg.vad, speechThreshold: v })} />
        <Slider label="Trailing silence" value={cfg.vad.redemptionMs} min={200} max={1500} step={50}
          fmt={(v) => `${v} ms`} onChange={(v) => set("vad", { ...cfg.vad, redemptionMs: v })} />
      </Section>

      <button onClick={() => update(DEFAULT_PIPELINE_CONFIG)}
        className="flex items-center gap-1.5 self-start rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
        <RotateCcw className="size-3.5" /> Reset to defaults
      </button>
    </div>
  );
}
