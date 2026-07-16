"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Languages, Gauge, AudioWaveform, Play, Loader2, RotateCcw, Star, Download, Check } from "lucide-react";
import { api } from "@/lib/api";
import {
  loadPipelineConfig, savePipelineConfig, WHISPER_SIZES, TURN_ENGINES, TTS_ENGINES,
  TURN_PRESETS, activeTurnPreset, type TurnPresetValues,
  DEFAULT_PIPELINE_CONFIG, mergePipelineConfig, type PipelineConfig, type TtsEngine,
} from "@/lib/live/pipelineConfig";
import { tts, modelsReady, modelsCached, loadModels, hasWebGPU } from "@/lib/live/models";
import { cn } from "@/lib/cn";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";

// Pipeline stages, in signal order. Each is a segment so it gets the full panel.
const STAGES = [
  { id: "mic", label: "VAD", sub: "Silero", icon: Mic },
  { id: "stt", label: "Speech-to-text", sub: "Whisper", icon: Languages },
  { id: "turn", label: "Turn-taking", sub: "Smart-Turn", icon: Gauge },
  { id: "tts", label: "Text-to-speech", sub: "Kokoro · Supertonic", icon: AudioWaveform },
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
    <div className="rounded-xl bg-card p-3 shadow-[var(--shadow-card)]">
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
    try { await loadModels((p) => setPct(p.pct)); } catch (e) { log.error("models", e); toast("Model download failed — check your connection and try again."); } finally { setBusy(false); }
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
      <StageHead title="Voice activity detection" desc="Silero VAD segments your speech — it decides when you start and stop talking. Applies when you next start a conversation." />
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
      <StageHead title="Speech-to-text" desc="Transcribes your voice on-device. Larger models are more accurate but heavier — the defaults favor modest machines; pick a bigger one if your device can carry it. Applies on the next call." />
      <EngineCard name="Whisper" desc="OpenAI Whisper via transformers.js — runs on WebGPU with a WASM fallback." />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-foreground">Model size</span>
        <select value={cfg.stt.whisperSize} onChange={(e) => update({ ...cfg, stt: { whisperSize: e.target.value as PipelineConfig["stt"]["whisperSize"] } })} className={selectClass}>
          {WHISPER_SIZES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {!hasWebGPU() && <p className="-mt-2 text-[11px] text-faint">WebGPU isn&apos;t available here, so calls run the Tiny model regardless — the size choice applies when WebGPU is.</p>}
      {cfg.stt.whisperSize === "large-v3-turbo" && <p className="-mt-2 text-[11px] text-faint">A big download and a real GPU-memory footprint — expect the best transcription, but drop back to Small if your machine struggles.</p>}
      <ModelStatus />
    </div>
  );
}

function TurnStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const preset = activeTurnPreset(cfg);
  const applyPreset = (v: TurnPresetValues) => update({
    ...cfg,
    vad: { ...cfg.vad, redemptionMs: v.redemptionMs },
    turn: { ...cfg.turn, threshold: v.threshold, holdMs: v.holdMs },
  });
  return (
    <div className="space-y-4">
      <StageHead title="Turn-taking" desc="Decides when you've actually finished speaking. Smart-Turn reads the semantics of your last words; silence timeout just waits out the trailing pause." />
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-card p-1 shadow-[var(--shadow-card)]">
        {TURN_PRESETS.map((p) => (
          <button key={p.id} onClick={() => applyPreset(p.values)} title={p.desc}
            className={cn("rounded-lg px-2 py-2 text-center transition", preset === p.id ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}>
            <span className="block text-[12px] font-medium leading-tight">{p.name}</span>
            <span className="block text-[9.5px] leading-tight text-faint">{p.desc}</span>
          </button>
        ))}
      </div>
      {preset === "custom" && <p className="-mt-2 text-[11px] text-faint">Custom — the sliders below (and trailing silence in the VAD stage) are hand-tuned.</p>}
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
      <Slider label="Mid-thought hold" value={cfg.turn.holdMs} min={1000} max={8000} step={500}
        fmt={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, holdMs: v } })} />
      <p className="-mt-2 text-[11px] text-faint">How long a &ldquo;not finished yet&rdquo; pause is held before it auto-sends. You can always tap &ldquo;send now&rdquo; (or press Enter) instead of waiting.</p>
    </div>
  );
}

const SAMPLE = "Hi! This is how I sound in a live conversation.";

function TtsStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const [busy, setBusy] = useState(false);
  // Preview always enabled: it downloads the models itself if needed (spinner
  // shows). A disabled-until-cached gate went stale — modelsCached() isn't
  // reactive, so the button stayed dead right after a download finished.
  const preview = async () => {
    setBusy(true);
    try {
      if (!modelsReady()) await loadModels(() => {});
      const { audio, sampleRate } = await tts(SAMPLE, { engine: cfg.tts.engine, voice: cfg.tts.voice, speed: cfg.tts.speed });
      const ctx = new AudioContext();
      const buf = ctx.createBuffer(1, audio.length, sampleRate);
      buf.getChannelData(0).set(audio);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start();
      src.onended = () => { void ctx.close(); };
    } catch (e) { log.error("tts", "voice preview:", e); toast("Voice preview failed — try downloading the models first."); } finally { setBusy(false); }
  };
  const engine = TTS_ENGINES.find((e) => e.id === cfg.tts.engine) ?? TTS_ENGINES[0]!;
  // Switching engines swaps the voice list too — mergePipelineConfig snaps the
  // voice to the new engine's default.
  const setEngine = (id: TtsEngine) => update(mergePipelineConfig({ ...cfg, tts: { ...cfg.tts, engine: id } }));
  const accents = [...new Set(engine.voices.map((v) => v.accent))];
  return (
    <div className="space-y-4">
      <StageHead title="Text-to-speech" desc="Speaks replies back to you on-device. Engine, voice, and speed apply to the next reply — switching engines downloads that engine's weights once." />
      <div className="grid grid-cols-2 gap-2">
        {TTS_ENGINES.map((e) => (
          <button key={e.id} onClick={() => setEngine(e.id)}
            className={cn("rounded-xl border p-3 text-left transition",
              cfg.tts.engine === e.id ? "border-accent/50 bg-accent/[0.07]" : "border-transparent bg-card shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-pop)]")}>
            <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
              {e.id === "kokoro" ? "Kokoro" : "Supertonic"}
              {cfg.tts.engine === e.id && <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent"><Star className="size-2.5" /> Active</span>}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {e.id === "kokoro" ? "82M StyleTTS2 — natural, 28 English voices (~82 MB)." : "Supertone's 66M flow-matching TTS — fastest first-word, 10 voices (~400 MB, OpenRAIL-M)."}
            </p>
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-foreground">Voice</span>
        <div className="flex items-center gap-2">
          <select value={cfg.tts.voice} onChange={(e) => update({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })} className={selectClass}>
            {accents.map((accent) => (
              <optgroup key={accent} label={accent}>
                {engine.voices.filter((v) => v.accent === accent).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.gender}</option>)}
              </optgroup>
            ))}
          </select>
          <button onClick={preview} disabled={busy} title="Play a sample (downloads the voice models first if needed)"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-40">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Preview
          </button>
        </div>
      </label>
      <Slider label="Speaking speed" value={cfg.tts.speed} min={0.5} max={2} step={0.05}
        fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => update({ ...cfg, tts: { ...cfg.tts, speed: v } })} />
      <NarrateToggle />
      <ModelStatus />
    </div>
  );
}

/** Spoken progress for coding-agent turns — a short voiced one-liner ("Step 2 of
 *  4 — refactor the store.") when a tool has run a while and the agent is quiet. */
function NarrateToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const on = (data as Record<string, string> | undefined)?.narrateProgress === "1";
  const flip = () => void api.updateSettings({ narrateProgress: on ? "" : "1" }).then(() => qc.invalidateQueries({ queryKey: ["settings"] }));
  return (
    <label className="flex cursor-pointer select-none items-start gap-2.5">
      <button role="switch" aria-checked={on} onClick={flip}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="text-[12.5px] leading-snug text-foreground">
        Narrate agent progress
        <span className="block text-[11px] text-faint">While a coding agent works in silence, speak its plan steps out loud (&ldquo;Step 2 of 4 — …&rdquo;). At most a few short lines a turn.</span>
      </span>
    </label>
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
        <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-card p-1 shadow-[var(--shadow-card)]">
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
