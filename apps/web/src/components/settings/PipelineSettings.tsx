"use client";

import { useState } from "react";
import { Mic, Languages, Gauge, AudioWaveform, Play, Loader2, RotateCcw, Star, Download, Check } from "lucide-react";
import {
  loadPipelineConfig, savePipelineConfig, KOKORO_VOICES, WHISPER_SIZES, TURN_ENGINES,
  DEFAULT_PIPELINE_CONFIG, type PipelineConfig,
} from "@/lib/live/pipelineConfig";
import { tts, modelsReady, modelsCached, loadModels } from "@/lib/live/models";
import { cn } from "@/lib/cn";

// Pipeline stages, in signal order. Each is a segment so it gets the full panel.
const STAGES = [
  { id: "mic", label: "Microphone", sub: "Silero VAD", icon: Mic },
  { id: "stt", label: "Speech", sub: "Whisper", icon: Languages },
  { id: "turn", label: "Turn-taking", sub: "Smart-Turn", icon: Gauge },
  { id: "tts", label: "Voice", sub: "Kokoro", icon: AudioWaveform },
] as const;
type StageId = (typeof STAGES)[number]["id"];

type Update = (next: PipelineConfig) => void;

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[12.5px] text-foreground">{label}<span className="tabular-nums text-muted-foreground">{fmt(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
    </label>
  );
}

const selectClass = "h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy";

// The built-in engine for a stage: named, described, badged "Default" (can't be
// removed). Additional swappable engines slot in beside this later.
function EngineCard({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {name}
        <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent"><Star className="size-2.5" /> Default</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

function StageHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

// Shared on-device model download status + prefetch (all stage weights load together).
function ModelStatus() {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const cached = typeof window !== "undefined" && (modelsReady() || modelsCached());
  const download = async () => {
    setBusy(true);
    try { await loadModels((p) => setPct(p.pct)); } catch (e) { console.error(e); } finally { setBusy(false); }
  };
  return cached ? (
    <p className="flex items-center gap-1.5 text-[11.5px] text-success"><Check className="size-3.5" /> Downloaded on this device.</p>
  ) : (
    <button onClick={download} disabled={busy}
      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground disabled:opacity-60">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {busy ? `Downloading… ${Math.round(pct * 100)}%` : "Download models now"}
    </button>
  );
}

function MicStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  return (
    <div className="space-y-4">
      <StageHead title="Microphone" desc="Silero voice-activity detection segments your speech. Applies when you next start a conversation." />
      <EngineCard name="Silero VAD" desc="Tiny on-device voice detector — decides when you're speaking and enables instant barge-in." />
      <Slider label="Speech sensitivity" value={cfg.vad.speechThreshold} min={0.1} max={0.9} step={0.05}
        fmt={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, speechThreshold: v } })} />
      <p className="-mt-2 text-[11px] text-faint">Lower picks up softer speech and barges in faster.</p>
      <Slider label="Trailing silence" value={cfg.vad.redemptionMs} min={200} max={1500} step={50}
        fmt={(v) => `${v} ms`} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, redemptionMs: v } })} />
      <p className="-mt-2 text-[11px] text-faint">How long a pause runs before your turn ends.</p>
    </div>
  );
}

function SttStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  return (
    <div className="space-y-4">
      <StageHead title="Speech-to-text" desc="Transcribes your voice on-device, English-only. Larger models are more accurate but heavier. Applies on the next call." />
      <EngineCard name="Whisper (English)" desc="OpenAI Whisper via transformers.js — runs on WebGPU with a WASM fallback." />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-foreground">Model size</span>
        <select value={cfg.stt.whisperSize} onChange={(e) => update({ ...cfg, stt: { whisperSize: e.target.value as PipelineConfig["stt"]["whisperSize"] } })} className={selectClass}>
          {WHISPER_SIZES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <ModelStatus />
    </div>
  );
}

function TurnStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  return (
    <div className="space-y-4">
      <StageHead title="Turn-taking" desc="Decides when you've actually finished speaking. Smart-Turn reads the semantics of your last words; silence timeout just waits out the trailing pause." />
      <EngineCard name="Smart-Turn v3" desc="Pipecat's semantic end-of-turn model — a Whisper-tiny encoder, ~12 ms on CPU." />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-foreground">Detector</span>
        <select value={cfg.turn.engine} onChange={(e) => update({ ...cfg, turn: { ...cfg.turn, engine: e.target.value as PipelineConfig["turn"]["engine"] } })} className={selectClass}>
          {TURN_ENGINES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {cfg.turn.engine === "smart-turn" && (
        <>
          <Slider label="End-of-turn threshold" value={cfg.turn.threshold} min={0} max={1} step={0.05}
            fmt={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, threshold: v } })} />
          <p className="-mt-2 text-[11px] text-faint">Higher waits longer (fewer interruptions); lower replies sooner.</p>
        </>
      )}
    </div>
  );
}

const SAMPLE = "Hi! This is how I sound in a live conversation.";

function TtsStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const [busy, setBusy] = useState(false);
  const canPreview = typeof window !== "undefined" && (modelsReady() || modelsCached());
  const preview = async () => {
    setBusy(true);
    try {
      if (!modelsReady()) await loadModels(() => {});
      const { audio, sampleRate } = await tts(SAMPLE, { voice: cfg.tts.voice, speed: cfg.tts.speed });
      const ctx = new AudioContext();
      const buf = ctx.createBuffer(1, audio.length, sampleRate);
      buf.getChannelData(0).set(audio);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start();
      src.onended = () => { void ctx.close(); };
    } catch (e) { console.error("voice preview:", e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <StageHead title="Voice" desc="Speaks replies back to you on-device — 28 English voices. Voice and speed apply to the next reply." />
      <EngineCard name="Kokoro TTS" desc="82M-param StyleTTS2 voice via kokoro-js — WebGPU with a WASM fallback." />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-foreground">Voice</span>
        <div className="flex items-center gap-2">
          <select value={cfg.tts.voice} onChange={(e) => update({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })} className={selectClass}>
            {(["American", "British"] as const).map((accent) => (
              <optgroup key={accent} label={accent}>
                {KOKORO_VOICES.filter((v) => v.accent === accent).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.gender}</option>)}
              </optgroup>
            ))}
          </select>
          <button onClick={preview} disabled={busy || !canPreview} title={canPreview ? "Play a sample" : "Download the voice models first"}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-40">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Preview
          </button>
        </div>
      </label>
      <Slider label="Speaking speed" value={cfg.tts.speed} min={0.5} max={2} step={0.05}
        fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => update({ ...cfg, tts: { ...cfg.tts, speed: v } })} />
      {!canPreview && <ModelStatus />}
    </div>
  );
}

export function PipelineSettings() {
  const [cfg, setCfg] = useState<PipelineConfig>(() => loadPipelineConfig());
  const [stage, setStage] = useState<StageId>("mic");
  const update: Update = (next) => setCfg(savePipelineConfig(next));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Your whole voice pipeline runs on-device — tune each stage below. Nothing here leaves your machine.
        </p>
        <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl border border-border bg-card p-1">
          {STAGES.map((s) => (
            <button key={s.id} onClick={() => setStage(s.id)}
              className={cn("flex flex-col items-center gap-1 rounded-lg px-2 py-2.5 text-center transition", stage === s.id ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}>
              <s.icon className="size-4" />
              <span className="text-[11.5px] font-medium leading-none">{s.label}</span>
              <span className="text-[9.5px] leading-none text-faint">{s.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[240px]">
        {stage === "mic" && <MicStage cfg={cfg} update={update} />}
        {stage === "stt" && <SttStage cfg={cfg} update={update} />}
        {stage === "turn" && <TurnStage cfg={cfg} update={update} />}
        {stage === "tts" && <TtsStage cfg={cfg} update={update} />}
      </div>

      <button onClick={() => update(DEFAULT_PIPELINE_CONFIG)}
        className="flex items-center gap-1.5 self-start rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
        <RotateCcw className="size-3.5" /> Reset to defaults
      </button>
    </div>
  );
}
