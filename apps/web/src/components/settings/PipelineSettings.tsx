"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { Mic, Languages, Gauge, AudioWaveform, Play, Loader2, RotateCcw, Star, Download, Check, Trash2, X, Cpu, ExternalLink, Lock } from "lucide-react";
import {
  loadPipelineConfig, savePipelineConfig, onPipelineConfig, WHISPER_SIZES, VAD_MODELS, TURN_ENGINES, TTS_FAMILIES, STT_FAMILIES, isNativeVariant,
  TURN_PRESETS, activeTurnPreset, type TurnPresetValues, chooseFamily, chooseVariant, familyInfo, browserTtsFallback,
  DEFAULT_PIPELINE_CONFIG, type PipelineConfig, type Stage, type EngineFamilyInfo, CURATED_LANGUAGES, languageSupport, pickCompatible,
  familyVariant, isRestricted, permitted,
} from "@/lib/live/pipelineConfig";
import { languageLabel, languagesNote, licenseTag, variantGroups, voiceMenu, engineName, switchNotice, missingEngines } from "@/lib/live/engineMenu";
import type { LanguageCode } from "@openlive/shared";
import {
  tts, modelsReady, modelsCached, loadModels, removeModel, hasWebGPU, resetNativeFallbacks,
  listNativeEngines, downloadNativeEngine, deleteNativeEngine, type NativeEngineStatus, type NativeFamilyStatus,
  getVoicePerf, setEngineAccel, rebenchEngine, type AccelProvider, type AccelResult,
} from "@/lib/live/models";
import { toSpeech } from "@/lib/live/voiceText";
import { compileLexicon } from "@openlive/shared/speech/lexicon";
import { cn } from "@/lib/cn";
import { Segmented } from "@/lib/seg";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";
import { usePendingDeletes } from "@/lib/deferredDelete";
import { prefersReduced } from "@/lib/gsap";

// Pipeline stages, in signal order. Each is a segment so it gets the full panel.
const STAGES = [
  { id: "mic", label: "VAD", sub: "Silero", icon: Mic },
  { id: "stt", label: "Speech-to-text", sub: `${STT_FAMILIES.length} engines`, icon: Languages },
  { id: "turn", label: "Turn-taking", sub: "Smart-Turn", icon: Gauge },
  { id: "tts", label: "Text-to-speech", sub: `${TTS_FAMILIES.length} engines`, icon: AudioWaveform },
] as const;
type StageId = (typeof STAGES)[number]["id"];

type Update = (next: PipelineConfig) => void;

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-label text-foreground">{label}<span className="tabular-nums text-muted-foreground">{fmt(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
    </label>
  );
}

const selectClass = "ol-select h-9 w-full rounded-lg border border-border bg-card px-3 text-label text-foreground outline-none focus:border-border-heavy";

// The built-in engine for a stage: named, described, badged "Default" (can't be
// removed). Additional swappable engines slot in beside this later.
function EngineCard({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="rounded-xl bg-card p-3 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2 text-body font-semibold text-foreground">
        {name}
        <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-medium text-accent"><Star className="size-2.5" /> Default</span>
      </div>
      <p className="mt-1 text-label leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

function StageHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h3 className="text-callout font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

// Shared on-device model download status + prefetch (all stage weights load together).
function ModelStatus({ removeKind }: { removeKind?: "whisper" | "kokoro" | "supertonic" }) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [removing, setRemoving] = useState(false);
  // modelsCached() is now config-aware (matches the SELECTED size/engine), so a
  // fresh size/engine correctly shows the download button instead of a false
  // "Downloaded". (Don't fall back to modelsReady() — that's true for ANY loaded
  // config and would re-introduce the "everything looks downloaded" bug.)
  const cached = typeof window !== "undefined" && modelsCached();
  const download = async () => {
    setBusy(true);
    try { await loadModels((p) => setPct(p.pct)); } catch (e) { log.error("models", e); toast("Model download failed — check your connection and try again."); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removeKind) return;
    setRemoving(true);
    try { const n = await removeModel(removeKind); toast(n ? "Removed — freed the disk it used. It re-downloads when next needed." : "Nothing to remove — not downloaded yet."); }
    catch { toast("Couldn't remove that model."); }
    finally { setRemoving(false); }
  };
  return cached ? (
    <div className="flex items-center gap-2.5">
      <p className="flex items-center gap-1.5 text-caption text-success"><Check className="size-3.5" /> Downloaded on this device.</p>
      {removeKind && (
        <button onClick={remove} disabled={removing}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-caption text-muted-foreground transition hover:border-border-heavy hover:text-danger disabled:opacity-50">
          {removing ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Remove
        </button>
      )}
    </div>
  ) : (
    <button onClick={download} disabled={busy}
      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-label text-muted-foreground transition hover:border-border-heavy hover:text-foreground disabled:opacity-60">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {busy ? `Downloading… ${Math.round(pct * 100)}%` : "Download models now"}
    </button>
  );
}

const ENGINE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-2";

// Card copy for every STT and TTS engine family (their ids never collide).
const ENGINE_COPY: Record<string, { title: string; desc: string }> = {
  whisper: { title: "Whisper", desc: "OpenAI Whisper via transformers.js, in the browser: WebGPU with a WASM fallback. Pick its size below." },
  nemotron: { title: "Nemotron Streaming", desc: "NVIDIA's 0.6B streaming model transcribes while you talk, so your words are ready as you stop." },
  parakeet: { title: "Parakeet TDT", desc: "NVIDIA's models, run once you stop talking, for high accuracy: English, or 25 languages in v3." },
  moonshine: { title: "Moonshine", desc: "Useful Sensors' small English models: the fastest and lightest native downloads, less accurate on long speech." },
  kokoro: { title: "Kokoro", desc: "82M StyleTTS2: natural, 28 English voices (~82 MB)." },
  supertonic: { title: "Supertonic", desc: "Supertone's 66M flow-matching TTS: quick first word, 10 voices (~400 MB)." },
  clone: { title: "Your voice", desc: "Cloned from a short recording. Record and manage them under Your voices below (runs locally)." },
  pocket: { title: "Pocket TTS", desc: "Streams speech as it is generated, the quickest to start talking. 2 voices." },
  kitten: { title: "Kitten TTS", desc: "KittenML's tiny models, streamed as they are generated. 8 voices." },
  "nemotron-3.5": { title: "Nemotron 3.5 Streaming", desc: "NVIDIA's multilingual streaming model: 28 languages, transcribed while you talk." },
  canary: { title: "Canary", desc: "NVIDIA's 180M model for English, Spanish, German and French." },
  piper: { title: "Piper", desc: "Small, clear voices, one language each." },
  "kokoro-native": { title: "Kokoro (CPU)", desc: "Kokoro on this machine's CPU, with voices in seven languages." },
  matcha: { title: "Matcha", desc: "A fast English voice from icefall." },
};

const mb = (n: number) => `${Math.round(n / 1e6)} MB`; // decimal, as the engine names in pipelineConfig.ts

// Two stages read this; one cache. Polls only while the agent reports a
// download this page did not start (one begun before a reload keeps going).
export const useNativeEngines = () => useQuery({
  queryKey: ["native-engines"], queryFn: () => listNativeEngines(), retry: 1,
  refetchInterval: (q) => (q.state.data?.some((f) => f.variants.some((e) => e.downloading)) ? 1000 : false),
});
export const variantStatus = (families: NativeFamilyStatus[] | undefined, id: string) => families?.flatMap((f) => f.variants).find((e) => e.id === id);

// Where native engines run on this device (the agent's accel.ts). Polls only
// while a benchmark is running or waiting for a call to end.
const useVoicePerf = () => useQuery({
  queryKey: ["voice-perf"], queryFn: getVoicePerf, retry: 1,
  refetchInterval: (q) => (Object.values(q.state.data?.engines ?? {}).some((a) => a.bench === "running" || a.bench === "queued") ? 2000 : false),
});
const PROVIDER_LABEL: Record<AccelProvider, string> = { cpu: "CPU", coreml: "CoreML", cuda: "CUDA", directml: "DirectML", webgpu: "WebGPU" };
const resultLine = (r: AccelResult) => ("error" in r ? `${PROVIDER_LABEL[r.provider]} can't run it` : `${PROVIDER_LABEL[r.provider]} ${r.firstMs} ms to first output, RTF ${r.rtf}`);

/** The installed engine's execution provider: Auto (the benchmark's pick) or
 *  one the user pins, the benchmark behind it, and a way to measure again. */
function AccelRow({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useVoicePerf();
  const [busy, setBusy] = useState(false);
  const a = data?.engines[id];
  if (!data || !a) return null;
  const { providers } = a;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast(`Couldn't change where it runs: ${String((err as Error)?.message ?? err)}`); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["voice-perf"] }); }
  };
  const status = {
    running: "Benchmarking on this device…",
    queued: "Benchmarks once no call is running.",
    pending: "Benchmarked on this device after its first use; CPU until then.",
    "cpu-only": "No accelerator on this device that OpenLive's speech runtime supports.",
    done: a.results.map(resultLine).join(" · "),
  }[a.bench];
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2">
      <label className="flex min-w-0 items-center gap-1.5 text-label text-muted-foreground">
        <Cpu className="size-3.5 shrink-0" /> Runs on
        <select value={a.override} disabled={busy || providers.length < 2} onChange={(ev) => void act(() => setEngineAccel(id, ev.target.value as AccelProvider | "auto"))}
          className={cn(selectClass, "w-auto")}>
          <option value="auto">Auto{a.override === "auto" ? ` (${PROVIDER_LABEL[a.provider]})` : ""}</option>
          {providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
        </select>
      </label>
      {providers.length > 1 && (
        <button onClick={() => void act(() => rebenchEngine(id))} disabled={busy || a.bench === "running"} className={rowButton}>
          {a.bench === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Re-run benchmark
        </button>
      )}
      <p className="basis-full text-caption text-faint" title={a.results.map((r) => ("error" in r ? `${r.provider}: ${r.error}` : "")).filter(Boolean).join("\n") || undefined}>
        {a.numThreads} {a.numThreads === 1 ? "thread" : "threads"} · {status}
      </p>
    </div>
  );
}

/** What the agent found this device to be; all of it stays on the machine. */
function DeviceSummary() {
  const { data } = useVoicePerf();
  if (!data) return null;
  const d = data.device;
  const gpu = d.gpus.map((g) => g.model).filter((m) => m !== d.cpu).join(", ");
  const accelerators = [...new Set([...d.providers, ...(d.ortProviders ?? [])])].filter((p) => p !== "cpu");
  const facts = [d.cpu, `${d.physicalCores ?? d.cores} cores`, `${Math.round(d.ramBytes / 2 ** 30)} GB`, gpu, d.osVersion,
    `${d.tier} tier`, accelerators.length > 0 && `${accelerators.map((p) => PROVIDER_LABEL[p]).join(", ")} available`].filter(Boolean);
  return <p className="mt-2 text-caption leading-relaxed text-faint">This device: {facts.join(" · ")}.</p>;
}

// A download outlives the stage panel that started it (switching stages
// unmounts the panel), so its progress and last error live at module scope.
const useEngineJobs = create<Record<string, { pct?: number; error?: string } | undefined>>(() => ({}));
const setJob = (id: string, job?: { pct?: number; error?: string }) => useEngineJobs.setState({ [id]: job });
const downloadAborts = new Map<string, AbortController>();

export async function downloadEngine(e: NativeEngineStatus, qc: QueryClient) {
  const abort = new AbortController();
  downloadAborts.set(e.id, abort);
  setJob(e.id, { pct: 0 });
  try {
    await downloadNativeEngine(e.id, (loaded, total) => setJob(e.id, { pct: loaded / total }), abort.signal);
    resetNativeFallbacks();
    setJob(e.id);
    toast(`${e.name} downloaded. It's used from your next reply.`, "info");
  } catch (err) {
    if (!abort.signal.aborted) log.error("voice", `${e.id} download:`, err);
    setJob(e.id, abort.signal.aborted ? undefined : { error: `Download failed: ${String((err as Error)?.message ?? err)}` });
  } finally {
    downloadAborts.delete(e.id);
    void qc.invalidateQueries({ queryKey: ["native-engines"] });
    void qc.invalidateQueries({ queryKey: ["voice-perf"] });
  }
}

/** Where an engine family runs, for its card: in the browser, or on this
 *  computer on the provider the agent chose there (accel.ts), which for a
 *  browser voice means its copy on the agent is downloaded. */
function useWhereItRuns() {
  const { data: engines } = useNativeEngines();
  const { data: perf } = useVoicePerf();
  return (f: EngineFamilyInfo, variant: string) => {
    const copy = f.native ? undefined : engines?.find((x) => x.browser === f.id)?.variants.find((v) => v.installed && v.runnable);
    const onComputer = f.native ? variant : copy?.id;
    if (!onComputer) return f.id === "clone" ? "This computer: CPU" : `Browser: ${hasWebGPU() ? "WebGPU" : "WASM"}`;
    const a = perf?.engines[onComputer];
    return a ? `This computer: ${PROVIDER_LABEL[a.provider]}` : "This computer";
  };
}

// One engine in a stage's picker. A native engine adds its size and installed
// state from the agent, which are missing while the agent is unreachable.
// `unsupported` names the languages it does speak when the session's is not
// among them: the card stays visible, greyed, and cannot be picked. `missing`
// says what plays instead while the active engine is not downloaded.
function EngineChoice({ id, active, streaming, note, where, status, unsupported, locked, missing, onPick }: {
  id: string; active: boolean; streaming?: boolean; note?: string; where: string; status?: NativeEngineStatus; unsupported?: string; locked?: boolean; missing?: string; onPick: () => void;
}) {
  const meta = [where, status && mb(status.sizeBytes), note, status?.installed && "Downloaded"].filter(Boolean).join(" · ");
  const copy = ENGINE_COPY[id] ?? { title: id, desc: "" };
  return (
    <button onClick={onPick} aria-pressed={active} disabled={!!unsupported && !active}
      className={cn("flex min-w-0 flex-col rounded-xl border p-3 text-left transition",
        active ? "border-accent/50 bg-accent/[0.07]" : "border-transparent bg-card shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-pop)]",
        unsupported && "opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-[var(--shadow-card)]")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body font-semibold text-foreground">
        <span className="min-w-0 break-words">{copy.title}</span>
        {active && !missing && <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-medium text-accent"><Star className="size-2.5" /> Active</span>}
        {active && missing && <span className="flex min-w-0 items-center gap-1 break-words rounded-full bg-arc/10 px-2 py-0.5 text-micro font-medium text-arc-text"><Download className="size-2.5 shrink-0" aria-hidden /> {missing}</span>}
        {streaming && <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-micro font-medium text-muted-foreground">Streaming</span>}
        {locked && <span className="flex items-center gap-1 rounded-full bg-arc/10 px-2 py-0.5 text-micro font-medium text-arc-text"><Lock className="size-2.5" aria-hidden /> Restricted license</span>}
      </div>
      <p className="mt-1 text-caption leading-relaxed text-muted-foreground">{copy.desc}</p>
      {unsupported && <p className="mt-1.5 text-caption font-medium text-foreground">{unsupported}</p>}
      {meta && <p className="mt-1.5 text-micro leading-relaxed text-faint">{meta}</p>}
    </button>
  );
}

const rowButton = "flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-label text-muted-foreground transition hover:border-border-heavy hover:text-foreground disabled:opacity-50";

/** Download, progress, cancel and remove for the selected native engine. Until
 *  it is installed the runtime uses `fallback`, and this says so. */
function NativeEngineRow({ id, fallback }: { id: string; fallback: string }) {
  const qc = useQueryClient();
  const { data, isError, refetch, isFetching } = useNativeEngines();
  const job = useEngineJobs((s) => s[id]);
  const [removing, setRemoving] = useState(false);
  const e = variantStatus(data, id);

  // Also cancels a download: the agent stops it and drops the partial files.
  const remove = async () => {
    if (!e) return;
    setRemoving(true);
    downloadAborts.get(id)?.abort();
    try {
      await deleteNativeEngine(id);
      setJob(id);
      if (e.installed) toast(`Removed ${e.name}, freed ${mb(e.bytes)}. It downloads again from here.`, "info");
    } catch (err) { setJob(id, { error: `Couldn't remove it: ${String((err as Error)?.message ?? err)}` }); }
    finally { setRemoving(false); void qc.invalidateQueries({ queryKey: ["native-engines"] }); void qc.invalidateQueries({ queryKey: ["voice-perf"] }); }
  };

  if (!e) return data || isError ? (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-label text-muted-foreground">Couldn&apos;t reach the voice engine, so calls use {fallback} for now. Is OpenLive&apos;s agent running?</span>
      <button onClick={() => void refetch()} disabled={isFetching} className={rowButton}>
        {isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Retry
      </button>
    </div>
  ) : <p className="text-label text-muted-foreground">Checking…</p>;

  const error = job?.error && <p role="alert" className="basis-full text-caption text-danger">{job.error}</p>;
  if (job?.pct !== undefined || e.downloading) {
    const pct = job?.pct;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 max-w-md flex-1 basis-40 flex-col gap-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div className={cn("h-full rounded-full bg-accent transition-[width]", pct === undefined && "w-full animate-pulse")}
              style={pct === undefined ? undefined : { width: `${Math.round(pct * 100)}%` }} />
          </div>
          <p className="text-caption text-faint">
            {pct === undefined ? `Downloading ${mb(e.sizeBytes)} in the background…` : `Downloading… ${Math.round(pct * 100)}% of ${mb(e.sizeBytes)}`}
          </p>
        </div>
        <button onClick={remove} disabled={removing} className={rowButton}>
          {removing ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Cancel
        </button>
      </div>
    );
  }
  return e.installed ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-1.5 text-label text-success"><Check className="size-3.5" /> Installed · {mb(e.bytes)} on disk</span>
      <button onClick={remove} disabled={removing} className={cn(rowButton, "hover:text-danger")}>
        {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Remove
      </button>
      {error}
      <AccelRow id={e.id} />
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <button onClick={() => void downloadEngine(e, qc)}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-label font-medium text-accent-foreground transition hover:opacity-90">
        <Download className="size-4" /> Download ({mb(e.sizeBytes)})
      </button>
      <span className="text-caption text-faint">Not downloaded yet, so calls use {fallback} until it is. Removable anytime.</span>
      {error}
    </div>
  );
}

const chip = "max-w-full break-words rounded-full bg-foreground/10 px-2 py-0.5 text-micro font-medium text-muted-foreground";

/** The active family's Model menu: every variant with its size, quality,
 *  latency and install state, grouped by language for Piper. One that cannot
 *  speak the session language stays listed, disabled, with the ones it can.
 *  The chosen variant's facts and license follow. */
function VariantPicker({ cfg, stage, update, onAsk }: { cfg: PipelineConfig; stage: Stage; update: Update; onAsk: () => void }) {
  const { data } = useNativeEngines();
  const family = familyInfo(stage, cfg[stage].family);
  if (!family || family.variants.length < 2) return null;
  const rows = family.variants.map((v) => ({ ...v, status: variantStatus(data, v.id) }));
  const speaks = (v: (typeof rows)[number]) => v.languages.includes(cfg.language);
  const line = (v: (typeof rows)[number]) => {
    const s = v.status;
    const license = s && licenseTag(s.license);
    return [s?.name ?? engineName(v.id), s && mb(s.sizeBytes), s?.quality, s?.latencyMs && !s.name.includes(`${s.latencyMs} ms`) && `${s.latencyMs} ms`,
      license ? license.kind !== "open" && license.label : v.restricted && "Restricted license", s?.installed && "Downloaded", !speaks(v) && languagesNote(v.languages)].filter(Boolean).join(" · ");
  };
  const options = (vs: typeof rows) => vs.map((v) => <option key={v.id} value={v.id} disabled={!speaks(v) || !permitted(cfg, v.id)}>{line(v)}</option>);
  const cur = rows.find((v) => v.id === cfg[stage].variant)?.status;
  const license = cur && licenseTag(cur.license);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-foreground">Model</span>
        <select value={cfg[stage].variant} onChange={(e) => update(chooseVariant(cfg, stage, e.target.value))} className={selectClass}>
          {variantGroups(rows, cfg.language).map((g) => (g.lang
            ? <optgroup key={g.lang} label={languageLabel(g.lang)}>{options(g.variants)}</optgroup>
            : options(g.variants)))}
        </select>
      </label>
      {cur && license && (
        <div className="flex flex-wrap gap-1.5">
          {[cur.quality[0]!.toUpperCase() + cur.quality.slice(1), cur.latencyMs && `${cur.latencyMs} ms chunks`, languagesNote(cur.languages)]
            .filter(Boolean).map((f) => <span key={String(f)} className={chip}>{f}</span>)}
          <span title={cur.license} className={cn(chip, license.kind === "restricted" && "bg-danger/10 text-danger", license.kind === "unknown" && "bg-arc/10 text-arc-text")}>
            {license.label}
          </span>
        </div>
      )}
      {!cfg.allowRestricted && rows.some((v) => v.restricted) && (
        <p className="text-caption text-faint">
          Models with a restricted license are locked.{" "}
          <button onClick={onAsk} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Allow them</button>
        </p>
      )}
    </div>
  );
}

/** The active engine's license, when it links one: Supertonic's and
 *  Nemotron's own terms, or what a restricted variant's license limits. */
function LicenseNote({ family, variant }: { family: EngineFamilyInfo; variant: string }) {
  const restricted = isRestricted(variant);
  if (!family.licenseUrl || (family.restriction && !restricted)) return null;
  return (
    <p className={cn("-mt-1 text-caption", restricted ? "text-arc-text" : "text-faint")}>
      {restricted ? `${family.name} has a restricted license. ${family.restriction}.` : `${family.name}'s model license: ${family.note}.`}{" "}
      <a href={family.licenseUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground">
        Read the license <ExternalLink className="size-3" aria-hidden />
      </a>
    </p>
  );
}

/** The inline OK a restricted model needs before it can be picked: what its
 *  license limits, a link to it, and an explicit Allow. The choice is saved in
 *  the pipeline config; OpenLive still never picks a restricted model itself. */
export function AllowRestricted({ family, onAllow, onCancel }: { family: EngineFamilyInfo; onAllow: () => void; onCancel?: () => void }) {
  return (
    <div role="group" aria-label={`Allow ${family.name}`} className="flex flex-col gap-2 rounded-lg border border-arc/40 bg-arc/10 px-3 py-2.5 text-label text-arc-text">
      <p className="min-w-0 break-words">
        <span className="font-medium">{family.name} has a restricted license.</span> {family.restriction}.{" "}
        {family.licenseUrl && (
          <a href={family.licenseUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
            Read the license <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </p>
      <p className="text-caption">Allowing restricted models unlocks them here, for you to pick. OpenLive never switches to one on its own.</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={onAllow} className="rounded-lg bg-foreground px-3 py-1.5 text-label font-medium text-background transition hover:opacity-90">Allow restricted models</button>
        {onCancel && <button onClick={onCancel} className={rowButton}>Not now</button>}
      </div>
    </div>
  );
}

/** Picking an engine family: straight away when its variant is permitted, else
 *  through AllowRestricted first. `asking` is the family waiting for that OK. */
function useFamilyPick(cfg: PipelineConfig, stage: Stage, update: Update) {
  const [asking, setAsking] = useState<string | null>(null);
  const pick = (f: EngineFamilyInfo) => {
    if (permitted(cfg, familyVariant(cfg, stage, f))) { setAsking(null); update(chooseFamily(cfg, stage, f.id)); } else setAsking(f.id);
  };
  const family = asking ? familyInfo(stage, asking) : undefined;
  const allow = () => {
    const next = { ...cfg, allowRestricted: true };
    update(cfg[stage].family === asking ? next : chooseFamily(next, stage, asking!));
    setAsking(null);
  };
  const gate = family && <AllowRestricted family={family} onAllow={allow} onCancel={() => setAsking(null)} />;
  return { pick, ask: () => setAsking(cfg[stage].family), gate };
}

function MicStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  return (
    <div className="space-y-4">
      <StageHead title="Voice activity detection" desc="Silero VAD segments your speech — it decides when you start and stop talking. Applies when you next start a conversation." />
      <EngineCard name="Silero VAD" desc="Tiny on-device voice detector — decides when you're speaking and enables instant barge-in." />
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-foreground">Model</span>
        <select value={cfg.vad.model} onChange={(e) => update({ ...cfg, vad: { ...cfg.vad, model: e.target.value as PipelineConfig["vad"]["model"] } })} className={selectClass}>
          {VAD_MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <Slider label="Speech sensitivity" value={cfg.vad.speechThreshold} min={0.1} max={0.9} step={0.05}
        fmt={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, speechThreshold: v } })} />
      <p className="-mt-2 text-caption text-faint">Lower picks up softer speech and barges in faster.</p>
      <Slider label="Trailing silence" value={cfg.vad.redemptionMs} min={200} max={1500} step={50}
        fmt={(v) => `${v} ms`} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, redemptionMs: v } })} />
      <p className="-mt-2 text-caption text-faint">How long a pause runs before your turn ends.</p>
    </div>
  );
}

/** The active card's badge while `stage`'s engine is not downloaded: what a call uses instead. */
const missingNote = (cfg: PipelineConfig, stage: Stage, engines?: NativeFamilyStatus[]) => {
  const gap = missingEngines(cfg, engines).find((m) => m.stage === stage);
  return gap && (gap.standIn ? `Not downloaded, using ${gap.standIn}` : "Not downloaded, no voice for the language");
};

const unsupportedNote = (f: EngineFamilyInfo, lang: LanguageCode) =>
  languageSupport(f.id, lang) ? undefined : languagesNote(f.variants.flatMap((v) => v.languages));

function SttStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const { data: engines } = useNativeEngines();
  const where = useWhereItRuns();
  const whisper = !isNativeVariant(cfg.stt.variant);
  const { pick, ask, gate } = useFamilyPick(cfg, "stt", update);
  const active = familyInfo("stt", cfg.stt.family);
  const missing = missingNote(cfg, "stt", engines);
  return (
    <div className="space-y-4">
      <StageHead title="Speech-to-text" desc="Transcribes your voice on this device: Whisper in the browser, or a native engine on this machine's CPU, downloaded once. Applies on the next call." />
      <div className={ENGINE_GRID}>
        {STT_FAMILIES.map((e) => {
          const variant = familyVariant(cfg, "stt", e);
          return (
            <EngineChoice key={e.id} id={e.id} active={cfg.stt.family === e.id} streaming={e.variants.some((v) => v.streaming)} note={e.note}
              unsupported={unsupportedNote(e, cfg.language)} where={where(e, variant)} locked={!permitted(cfg, variant)}
              missing={missing} status={variantStatus(engines, variant)} onPick={() => pick(e)} />
          );
        })}
      </div>
      {gate}
      {active && <LicenseNote family={active} variant={cfg.stt.variant} />}
      {whisper && <label className="flex flex-col gap-1.5">
        <span className="text-label text-foreground">Model size</span>
        <select value={cfg.stt.whisperSize} onChange={(e) => update({ ...cfg, stt: { ...cfg.stt, whisperSize: e.target.value as PipelineConfig["stt"]["whisperSize"] } })} className={selectClass}>
          {WHISPER_SIZES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>}
      {whisper && <p className="-mt-2 text-caption text-faint">English runs the English-only build of each size; any other language loads the multilingual build of the same size, automatically.</p>}
      {!whisper && <VariantPicker cfg={cfg} stage="stt" update={update} onAsk={ask} />}
      {whisper && !hasWebGPU() && <p className="-mt-2 text-caption text-faint">WebGPU isn&apos;t available here, so calls run the Tiny model regardless. The size choice applies when WebGPU is.</p>}
      {whisper && cfg.stt.whisperSize === "large-v3-turbo" && <p className="-mt-2 text-caption text-faint">A big download and a real GPU-memory footprint: expect the best transcription, but drop back to Small if your machine struggles.</p>}
      {whisper ? <ModelStatus removeKind="whisper" /> : <NativeEngineRow id={cfg.stt.variant} fallback="Whisper" />}
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
      <Segmented label="Turn-taking preset" tone="soft" className="grid w-full" value={preset}
        options={TURN_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: p.desc, title: p.desc }))}
        onChange={(id) => { const p = TURN_PRESETS.find((t) => t.id === id); if (p) applyPreset(p.values); }} />
      {preset === "custom" && <p className="-mt-2 text-caption text-faint">Custom — the sliders below (and trailing silence in the VAD stage) are hand-tuned.</p>}
      <EngineCard name="Smart-Turn v3" desc="Pipecat's semantic end-of-turn model — a Whisper-tiny encoder, ~12 ms on CPU." />
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-foreground">Detector</span>
        <select value={cfg.turn.engine} onChange={(e) => update({ ...cfg, turn: { ...cfg.turn, engine: e.target.value as PipelineConfig["turn"]["engine"] } })} className={selectClass}>
          {TURN_ENGINES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {cfg.turn.engine === "smart-turn" && (
        <>
          <Slider label="End-of-turn threshold" value={cfg.turn.threshold} min={0} max={1} step={0.05}
            fmt={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, threshold: v } })} />
          <p className="-mt-2 text-caption text-faint">Higher waits longer (fewer interruptions); lower replies sooner.</p>
        </>
      )}
      <Slider label="Mid-thought hold" value={cfg.turn.holdMs} min={1000} max={8000} step={500}
        fmt={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, holdMs: v } })} />
      <p className="-mt-2 text-caption text-faint">How long a &ldquo;not finished yet&rdquo; pause is held before it auto-sends. You can always tap &ldquo;send now&rdquo; (or press Enter) instead of waiting.</p>
    </div>
  );
}

const SAMPLE = "Hi! This is how I sound in a live conversation.";

/** Play `text` as a live reply would sound with `cfg`: normalized, respelled
 *  by the dictionary, in the chosen voice. Loads the browser models first when
 *  the voice is one of them. */
export async function playPreview(text: string, cfg: PipelineConfig) {
  if (!isNativeVariant(cfg.tts.variant) && !modelsReady()) await loadModels(() => {});
  const said = toSpeech(text, cfg.language, compileLexicon(cfg.pronunciations, cfg.language));
  const { audio, sampleRate } = await tts(said, { engine: cfg.tts.variant, voice: cfg.tts.voice, speed: cfg.tts.speed, lang: cfg.language });
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, audio.length, sampleRate);
  buf.getChannelData(0).set(audio);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  src.onended = () => { void ctx.close(); };
}

function TtsStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const [busy, setBusy] = useState(false);
  const { data: engines } = useNativeEngines();
  const where = useWhereItRuns();
  const native = isNativeVariant(cfg.tts.variant);
  const status = variantStatus(engines, cfg.tts.variant);
  const missing = missingNote(cfg, "tts", engines);
  // This browser voice's copy on the agent, when the agent has one that runs here.
  const copy = native ? undefined : engines?.find((f) => f.browser === cfg.tts.family)?.variants.find((v) => v.runnable);
  // Preview always enabled: it downloads the models itself if needed (spinner
  // shows). A disabled-until-cached gate went stale — modelsCached() isn't
  // reactive, so the button stayed dead right after a download finished.
  const preview = async () => {
    setBusy(true);
    try {
      await playPreview(SAMPLE, cfg);
    } catch (e) { log.error("tts", "voice preview:", e); toast("Voice preview failed — try downloading the models first."); } finally { setBusy(false); }
  };
  const engine = familyInfo("tts", cfg.tts.family) ?? TTS_FAMILIES[0]!;
  // Switching engines swaps the voice list too: chooseFamily snaps the voice to
  // the new engine's default. A native engine without a static list names its
  // voices in the agent's catalog, cut to the session language.
  const { pick, ask, gate } = useFamilyPick(cfg, "tts", update);
  const voices = engine.voices?.map((v) => ({ id: v.id, name: v.name, group: v.accent, gender: v.gender })) ?? voiceMenu(status?.voices ?? [], cfg.language);
  const groups = [...new Set(voices.map((v) => v.group))];
  const standIn = familyInfo("tts", browserTtsFallback(cfg.language) ?? "")?.name ?? "no voice";
  return (
    <div className="space-y-4">
      <StageHead title="Text-to-speech" desc="Speaks replies back to you on this device. Engine and voice apply to the next reply. Kokoro and Supertonic download their weights on first use; native engines, and Supertonic on this computer, are a one-time download below. Speaking speed is at the top of this tab." />
      <div className={ENGINE_GRID}>
        {TTS_FAMILIES.map((e) => {
          const variant = familyVariant(cfg, "tts", e);
          return (
            <EngineChoice key={e.id} id={e.id} active={cfg.tts.family === e.id} note={e.note} unsupported={unsupportedNote(e, cfg.language)}
              locked={!permitted(cfg, variant)} where={where(e, variant)} missing={missing} status={variantStatus(engines, variant)} onPick={() => pick(e)} />
          );
        })}
      </div>
      {gate}
      <LicenseNote family={engine} variant={cfg.tts.variant} />
      <VariantPicker cfg={cfg} stage="tts" update={update} onAsk={ask} />
      {cfg.tts.family === "clone" ? (
        <CloneVoicePicker cfg={cfg} update={update} />
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="text-label text-foreground">Voice</span>
          <div className="flex items-center gap-2">
            <select value={cfg.tts.voice} onChange={(e) => update({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })} className={selectClass}>
              {!engine.voices && <option value="">Default for the language</option>}
              {cfg.tts.voice && !voices.some((v) => v.id === cfg.tts.voice) && <option value={cfg.tts.voice}>{cfg.tts.voice}</option>}
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {voices.filter((v) => v.group === group).map((v) => <option key={v.id} value={v.id}>{v.gender ? `${v.name} · ${v.gender}` : v.name}</option>)}
                </optgroup>
              ))}
            </select>
            <button onClick={preview} disabled={busy || (native && !status?.installed)}
              title={native && !status?.installed ? "Download this engine first" : "Play a sample (downloads the voice models first if needed)"}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 text-label font-medium text-background transition hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Preview
            </button>
          </div>
        </label>
      )}
      {native ? <NativeEngineRow id={cfg.tts.variant} fallback={standIn} />
        : <ModelStatus removeKind={cfg.tts.family === "supertonic" ? "supertonic" : cfg.tts.family === "kokoro" ? "kokoro" : undefined} />}
      {copy && (
        <div className="space-y-2">
          <p className="text-label text-foreground">On this computer</p>
          <p className="text-caption text-faint">
            {engine.name} can also run in OpenLive&apos;s agent, on this computer&apos;s CPU or GPU, whichever it measures faster here. Same voice; the browser copy above stays the fallback. {mb(copy.sizeBytes)}, {copy.license}.
          </p>
          <NativeEngineRow id={copy.id} fallback={`${engine.name} in the browser`} />
        </div>
      )}
    </div>
  );
}

/** Voice picker for the clone engine: just your saved profiles. Recording,
 *  previewing, and managing them lives under Your voices, further down this tab. */
function CloneVoicePicker({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const { data: allProfiles = [], isLoading } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["voice-profiles"], queryFn: async () => {
      const r = await fetch("/api/voice/profiles");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const pending = usePendingDeletes((s) => s.keys);
  const profiles = allProfiles.filter((p) => !pending.has(`voice:${p.id}`));
  const openVoices = () => document.getElementById("set-voice-yours")?.scrollIntoView({ behavior: prefersReduced() ? "auto" : "smooth", block: "start" });
  if (!isLoading && profiles.length === 0) return (
    <div className="flex items-center gap-2 rounded-lg border border-arc/40 bg-arc/10 px-3 py-2 text-label text-arc-text">
      No cloned voices yet.
      <button onClick={openVoices} className="font-medium underline underline-offset-2">Record one under Your voices</button>
    </div>
  );
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-foreground">Voice</span>
      <div className="flex items-center gap-2">
        <select value={cfg.tts.voice} onChange={(e) => update({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })} className={selectClass}>
          {!profiles.some((p) => p.id === cfg.tts.voice) && <option value={cfg.tts.voice}>Pick a voice…</option>}
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={openVoices}
          className="h-9 shrink-0 rounded-lg border border-border px-3 text-label text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
          Manage your voices
        </button>
      </div>
    </label>
  );
}

/** The download a switch notice or the call lobby asks for, sharing the stage rows' job store. */
export function NoticeDownload({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useNativeEngines();
  const job = useEngineJobs((s) => s[id]);
  const e = variantStatus(data, id);
  if (!e) return <span className="text-caption">Start OpenLive&apos;s agent to download it.</span>;
  if (e.installed) return <span className="flex items-center gap-1.5 text-success"><Check className="size-3.5" /> Downloaded</span>;
  if (job?.pct !== undefined || e.downloading) {
    return <span className="flex items-center gap-1.5 tabular-nums"><Loader2 className="size-3.5 animate-spin" /> Downloading{job?.pct === undefined ? "…" : ` ${Math.round(job.pct * 100)}%`}</span>;
  }
  return (
    <>
      <button onClick={() => void downloadEngine(e, qc)}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-label font-medium text-accent-foreground transition hover:opacity-90">
        <Download className="size-3.5" /> Download ({mb(e.sizeBytes)})
      </button>
      {job?.error && <span role="alert" className="basis-full text-caption text-danger">{job.error}</span>}
    </>
  );
}

/** The session language, above every stage since each follows it. A change
 *  swaps any engine that cannot speak it (preferring what is downloaded) and
 *  says what changed, with a Download for anything that is not on disk yet. */
export function LanguagePicker() {
  const [cfg, setCfg] = useState<PipelineConfig>(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setCfg), []);
  const { data, isError } = useNativeEngines();
  const [notice, setNotice] = useState<{ lang: LanguageCode; lines: { text: string; download?: string }[] } | null>(null);
  const choose = (lang: LanguageCode) => {
    // With the agent unreachable nothing native counts as downloaded; while it is still loading, everything does.
    const { cfg: picked, changes, unsupported } = pickCompatible(cfg, lang, data ?? (isError ? [] : undefined));
    // A native voice kept only when the catalog lists it for the language. Else
    // (Kokoro CPU's af_heart after a switch to Spanish, or the agent not heard
    // from yet) it gives way to the one the agent picks for the language, which
    // is what the agent would read in anyway, under a name the menu no longer shows.
    const voice = variantStatus(data, picked.tts.variant)?.voices?.find((v) => v.id === picked.tts.voice);
    const keep = !isNativeVariant(picked.tts.variant) || (voice && (!voice.lang || voice.lang === lang));
    const next = keep ? picked : { ...picked, tts: { ...picked.tts, voice: "" } };
    setCfg(savePipelineConfig(next));
    const lines = switchNotice(lang, changes, unsupported, (id) => engineName(id, data));
    setNotice(lines.length ? { lang, lines } : null);
    if (!lines.length) toast(`Language set to ${languageLabel(lang)}. Your engines already speak it.`, "info");
  };
  return (
    <div className="flex flex-col gap-3">
      <select aria-label="Language" value={cfg.language} onChange={(e) => choose(e.target.value as LanguageCode)} className={cn(selectClass, "max-w-md")}>
        {CURATED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{languageLabel(l.code)}</option>)}
      </select>
      {notice && (
        <div role="status" className="flex max-w-xl flex-col gap-2 rounded-lg border border-arc/40 bg-arc/10 px-3 py-2 text-label text-arc-text">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-medium">Switched to {languageLabel(notice.lang)}, so some engines changed:</p>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 transition hover:bg-arc/15"><X className="size-3.5" /></button>
          </div>
          {notice.lines.map((n) => (
            <div key={n.text} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 break-words">{n.text}</span>
              {n.download && <NoticeDownload id={n.download} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PipelineSettings() {
  const [cfg, setCfg] = useState<PipelineConfig>(() => loadPipelineConfig());
  const [stage, setStage] = useState<StageId>("mic");
  const update: Update = (next) => setCfg(savePipelineConfig(next));
  const { data: engines } = useNativeEngines();
  const onDisk = engines?.flatMap((f) => f.variants).filter((v) => v.installed) ?? [];
  const diskBytes = onDisk.reduce((n, v) => n + v.bytes, 0);
  useEffect(() => onPipelineConfig(setCfg), []);
  // Local and exactly reversible, so the reset applies now and Undo puts the old
  // config back, rather than deferring like a delete.
  const reset = () => {
    const prev = cfg;
    // The dictionary and the restricted-license OK are the user's, not engine setup.
    update({ ...DEFAULT_PIPELINE_CONFIG, pronunciations: cfg.pronunciations, allowRestricted: cfg.allowRestricted });
    toast("Speech engine reset to defaults", "info", { undo: () => savePipelineConfig(prev), commit: () => {} });
  };

  return (
    <div className="flex flex-col gap-6">
      <div id="set-voice-device">
        <p className="text-label leading-relaxed text-muted-foreground">
          Your whole voice pipeline runs on-device — tune each stage below. Nothing here leaves your machine.
        </p>
        <DeviceSummary />
        <Segmented label="Pipeline stage" tone="soft" anchor="set-voice-stage" className="mt-3 grid w-full"
          options={STAGES} value={stage} onChange={setStage} />
      </div>

      <div className="min-h-[240px]">
        {stage === "mic" && <MicStage cfg={cfg} update={update} />}
        {stage === "stt" && <SttStage cfg={cfg} update={update} />}
        {stage === "turn" && <TurnStage cfg={cfg} update={update} />}
        {stage === "tts" && <TtsStage cfg={cfg} update={update} />}
      </div>

      {onDisk.length > 0 && (
        <p className="-mb-3 text-caption text-faint">
          Native models on disk: {diskBytes >= 1e9 ? `${(diskBytes / 1e9).toFixed(1)} GB` : mb(diskBytes)} across {onDisk.length} {onDisk.length === 1 ? "model" : "models"}.
        </p>
      )}
      {cfg.allowRestricted && (
        <p className="-mb-3 text-caption text-faint">
          Models with a restricted license are allowed.{" "}
          <button onClick={() => update({ ...cfg, allowRestricted: false })} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Lock them again</button>
          {" "}(the engines in use keep working).
        </p>
      )}
      <button id="set-voice-reset" onClick={reset}
        className="flex items-center gap-1.5 self-start rounded-lg border border-border px-3 py-1.5 text-label text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
        <RotateCcw className="size-3.5" /> Reset to defaults
      </button>
    </div>
  );
}
