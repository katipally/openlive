"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { holdFloor, releaseWhenFree } from "@/lib/keepScroll";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { Mic, Languages, Gauge, AudioWaveform, Loader2, RotateCcw, Download, Check, Trash2, X, Cpu, ExternalLink, Lock } from "lucide-react";
import {
  loadPipelineConfig, savePipelineConfig, onPipelineConfig, WHISPER_SIZES, VAD_MODELS, VOICEPRINT_ENGINE, type VoiceprintMode, ADDRESSEE_ENGINE, type SideTalk, TURN_ENGINES, TTS_FAMILIES, STT_FAMILIES, isNativeVariant,
  TURN_PRESETS, activeTurnPreset, chooseFamily, chooseVariant, familyInfo, browserTtsFallback,
  DEFAULT_PIPELINE_CONFIG, type PipelineConfig, type Stage, type EngineFamilyInfo, CURATED_LANGUAGES, languageSupport, pickCompatible,
  familyVariant, isRestricted, permitted,
} from "@/lib/live/pipelineConfig";
import { languageLabel, languagesNote, licenseTag, variantGroups, engineName, switchNotice, missingEngines } from "@/lib/live/engineMenu";
import type { LanguageCode } from "@openlive/shared";
import {
  tts, modelsReady, modelsCached, loadModels, removeModel, hasWebGPU, resetNativeFallbacks,
  listNativeEngines, downloadModel, deleteNativeEngine, type NativeEngineStatus, type NativeFamilyStatus,
  getVoicePerf, setEngineAccel, rebenchEngine, type AccelProvider, type AccelResult,
} from "@/lib/live/models";
import { toSpeech } from "@/lib/live/voiceText";
import { enrollVoice, forgetVoiceprint, voiceprintStatus } from "@/lib/live/voiceprint";
import { addresseeStatus, deleteJudgmentLog } from "@/lib/live/addressee";
import { Switch, Select, Slider, Button, Tooltip, Badge, Segmented, type SegOption, Advanced, InfoTip, notice, Notice } from "@/components/ui";
import { MicVAD } from "@ricky0123/vad-web";
import { useLiveStore } from "@/lib/live/liveStore";
import { compileLexicon } from "@openlive/shared/speech/lexicon";
import { cn } from "@/lib/cn";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";
import { LinkRow, useSettingsNav } from "./nav";

// Pipeline stages, in signal order. Each is a segment so it gets the full panel.
const STAGES = [
  { id: "mic", label: "VAD", sub: "Silero", icon: Mic },
  { id: "stt", label: "Speech-to-text", sub: `${STT_FAMILIES.length} engines`, icon: Languages },
  { id: "turn", label: "Turn-taking", sub: "Smart-Turn", icon: Gauge },
  { id: "tts", label: "Text-to-speech", sub: `${TTS_FAMILIES.length} engines`, icon: AudioWaveform },
] as const;
type StageId = (typeof STAGES)[number]["id"];

type Update = (next: PipelineConfig) => void;

function StageHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h3 className="text-callout font-semibold text-foreground">{title}</h3>
      <Tooltip label={desc} truncated className="mt-0.5 flex min-w-0 max-w-full">
        <span className="min-w-0 truncate text-label text-muted-foreground">{desc}</span>
      </Tooltip>
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
    try { await loadModels((p) => setPct(p.pct), "settings"); } catch (e) { log.error("models", e); toast("Model download failed. Check your connection and try again."); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removeKind) return;
    setRemoving(true);
    try { const n = await removeModel(removeKind); toast(n ? "Removed, and the disk it used is free. It re-downloads when next needed." : "Nothing to remove. It isn't downloaded yet."); }
    catch { toast("Couldn't remove that model."); }
    finally { setRemoving(false); }
  };
  return cached ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-1.5 text-label text-success"><Check className="size-3.5" /> Downloaded on this device</span>
      {removeKind && (
        <Button size="sm" onClick={remove} disabled={removing} className="enabled:hover:text-danger">
          {removing ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
        </Button>
      )}
    </div>
  ) : (
    <Button size="sm" onClick={download} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />}
      {busy ? `Downloading… ${Math.round(pct * 100)}%` : "Download models now"}
    </Button>
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
  clone: { title: "Your voice", desc: "Cloned from a short recording. Record and manage them in Voice, under Your voices (runs locally)." },
  pocket: { title: "Pocket TTS", desc: "Streams speech as it is generated, the quickest to start talking. 2 voices." },
  kitten: { title: "Kitten TTS", desc: "KittenML's tiny models, streamed as they are generated. 8 voices." },
  "nemotron-3.5": { title: "Nemotron 3.5 Streaming", desc: "NVIDIA's multilingual streaming model: 28 languages, transcribed while you talk." },
  canary: { title: "Canary", desc: "NVIDIA's 180M model for English, Spanish, German and French." },
  piper: { title: "Piper", desc: "Small, clear voices, one language each." },
  "kokoro-native": { title: "Kokoro (CPU)", desc: "Kokoro on this machine's CPU, with voices in seven languages." },
  matcha: { title: "Matcha", desc: "A fast English voice from icefall." },
  v6: { title: "Silero VAD v6.2", desc: "Recommended. Better at quiet voices, noisy rooms and phone-quality audio." },
  v5: { title: "Silero VAD v5", desc: "The previous model, for hardware where v6.2 misbehaves." },
  "smart-turn": { title: "Smart-Turn v3", desc: "Listens for a finished thought, not just silence. About 250 ms a check, on the CPU." },
  silence: { title: "Silence timeout", desc: "Replies after a fixed pause. No model at all." },
};

const mb = (n: number) => `${Math.round(n / 1e6)} MB`; // decimal, as the engine names in pipelineConfig.ts

// Two stages read this; one cache. Polls only while the agent reports a
// download this page did not start (one begun before a reload keeps going).
// Rechecked whenever a view showing it opens or the window regains focus: a
// model installed or removed from another window or the Flow bar changes it too.
export const useNativeEngines = () => useQuery({
  queryKey: ["native-engines"], queryFn: () => listNativeEngines(), retry: 1, refetchOnMount: "always", refetchOnWindowFocus: true,
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
  const errors = a.results.map((r) => ("error" in r ? `${r.provider}: ${r.error}` : "")).filter(Boolean).join("\n");
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2">
      <label className="flex min-w-0 items-center gap-1.5 text-label text-muted-foreground">
        <Cpu className="size-3.5 shrink-0" /> Runs on
        <Select value={a.override} disabled={busy || providers.length < 2} onChange={(ev) => void act(() => setEngineAccel(id, ev.target.value as AccelProvider | "auto"))}>
          <option value="auto">Auto{a.override === "auto" ? ` (${PROVIDER_LABEL[a.provider]})` : ""}</option>
          {providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
        </Select>
      </label>
      {providers.length > 1 && (
        <Button size="sm" onClick={() => void act(() => rebenchEngine(id))} disabled={busy || a.bench === "running"}>
          {a.bench === "running" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Re-run benchmark
        </Button>
      )}
      <Tooltip label={errors && <span className="whitespace-pre-line">{errors}</span>} className="basis-full">
        <p className="text-caption text-faint">{a.numThreads} {a.numThreads === 1 ? "thread" : "threads"} · {status}</p>
      </Tooltip>
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
  return (
    <p className="flex items-start gap-2 text-caption leading-relaxed text-faint">
      <Cpu aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <Tooltip label={facts.join(" · ")} truncated className="flex min-w-0">
        <span className="min-w-0 truncate">This device: {facts.join(" · ")}</span>
      </Tooltip>
    </p>
  );
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
    await downloadModel(`/api/voice/engines/${e.id}/download`, (loaded, total) => setJob(e.id, { pct: loaded / total }), abort.signal);
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
        active ? "border-accent/50 bg-accent/[0.07]" : "border-transparent bg-card shadow-card hover:shadow-pop",
        unsupported && "opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-card")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body font-semibold text-foreground">
        <span className="min-w-0 break-words">{copy.title}</span>
        {active && !missing && <Badge tone="accent"><Check aria-hidden /> Active</Badge>}
        {active && missing && <Badge tone="arc" className="min-w-0"><Download aria-hidden /> {missing}</Badge>}
        {streaming && <Badge>Streaming</Badge>}
        {locked && <Badge tone="arc"><Lock aria-hidden /> Restricted license</Badge>}
      </div>
      <Tooltip label={copy.desc} truncated className="mt-1 flex">
        <span className="line-clamp-2 text-caption text-muted-foreground">{copy.desc}</span>
      </Tooltip>
      {unsupported && <p className="mt-1.5 text-caption font-medium text-foreground">{unsupported}</p>}
      {/* At the foot, so cards in one row (stretched to one height) line it up. */}
      {meta && <p className="mt-auto pt-1.5 text-micro leading-relaxed text-faint">{meta}</p>}
    </button>
  );
}

/** Download, progress, cancel and remove for the selected native engine. Until
 *  it is installed the runtime uses `fallback`, and this says so. */
function NativeEngineRow({ id, fallback, accel = true }: { id: string; fallback: string; accel?: boolean }) {
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
      <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
        {isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
      </Button>
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
        <Button size="sm" onClick={remove} disabled={removing}>
          {removing ? <Loader2 className="animate-spin" /> : <X />} Cancel
        </Button>
      </div>
    );
  }
  return e.installed ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-1.5 text-label text-success"><Check className="size-3.5" /> Installed · {mb(e.bytes)} on disk</span>
      <Button size="sm" onClick={remove} disabled={removing} className="enabled:hover:text-danger">
        {removing ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
      </Button>
      {error}
      {accel && <AccelRow id={e.id} />}
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button variant="primary" onClick={() => void downloadEngine(e, qc)}>
        <Download /> Download ({mb(e.sizeBytes)})
      </Button>
      <span className="text-caption text-faint">Not downloaded yet. Until it is, calls use {fallback}. Removable anytime.</span>
      {error}
    </div>
  );
}

/** A feature still being tuned. Inside its control's label, so it is read with it. */
export const Experimental = () => <Badge tone="arc">Experimental</Badge>;

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
        <Select value={cfg[stage].variant} onChange={(e) => update(chooseVariant(cfg, stage, e.target.value))} className="w-full">
          {variantGroups(rows, cfg.language).map((g) => (g.lang
            ? <optgroup key={g.lang} label={languageLabel(g.lang)}>{options(g.variants)}</optgroup>
            : options(g.variants)))}
        </Select>
      </label>
      {cur && license && (
        <div className="flex flex-wrap gap-1.5">
          {[cur.quality[0]!.toUpperCase() + cur.quality.slice(1), cur.latencyMs && `${cur.latencyMs} ms chunks`, languagesNote(cur.languages)]
            .filter(Boolean).map((f) => <Badge key={String(f)}>{f}</Badge>)}
          <Tooltip label={cur.license}>
            <Badge tone={license.kind === "restricted" ? "danger" : license.kind === "unknown" ? "arc" : "neutral"}>{license.label}</Badge>
          </Tooltip>
        </div>
      )}
      {!cfg.allowRestricted && rows.some((v) => v.restricted) && (
        <p className="text-caption text-faint">
          Models with a restricted license are locked.{" "}
          <button onClick={onAsk} className="hit text-muted-foreground underline underline-offset-2 hover:text-foreground">Allow them</button>
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
    <div role="group" aria-label={`Allow ${family.name}`} className={cn(notice(), "flex-col")}>
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
        <Button variant="primary" size="sm" onClick={onAllow}>Allow restricted models</Button>
        {onCancel && <Button size="sm" onClick={onCancel}>Not now</Button>}
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

const VOICEPRINT_MODES_UI: SegOption<VoiceprintMode>[] = [{ id: "off", label: "Off" }, { id: "label", label: "Label voices" }, { id: "gate", label: "Only me" }];
const VOICEPRINT_COPY: Record<VoiceprintMode, string> = {
  off: "Anyone who talks can start a turn.",
  label: "Anyone can still start a turn; the transcript marks each one as you or another voice.",
  gate: "Only your voice starts a turn or cuts in while the agent talks; other people and the agent's own voice are ignored. Push-to-talk always goes through, and if the check can't run, everyone is heard.",
};
// Read aloud to enroll: varied sounds, about 15 s at a relaxed pace.
const ENROLL_TEXT = "The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. People look, but no one ever finds it.";
const ENROLL_S = 15;
const voiceprintKey = ["voiceprint"];

/** Records the user reading ENROLL_TEXT on the call's mic and hands the agent
 *  each stretch of speech the VAD finds, until ENROLL_S is in. */
function useEnrollment(cfg: PipelineConfig) {
  const qc = useQueryClient();
  const [state, setState] = useState<{ seconds: number; error?: string } | null>(null);
  const [stop, setStop] = useState<(() => void) | null>(null);
  // Settings can close while the permission prompt is up or the VAD loads: no effect cleanup has this recording's stop yet.
  const unmounted = useRef(false);
  useEffect(() => { unmounted.current = false; return () => { unmounted.current = true; }; }, []);
  const start = async () => {
    setState({ seconds: 0 });
    let stream: MediaStream;
    try {
      const micId = useLiveStore.getState().micId;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(micId && { deviceId: { exact: micId } }) } });
    } catch { return setState({ seconds: 0, error: "Couldn't open the microphone." }); }
    if (unmounted.current) return stream.getTracks().forEach((t) => t.stop());
    const mic = stream.getAudioTracks()[0]?.label ?? "";
    // `heard`: seconds of the stretch being read now (-1 between stretches), so the
    // bar moves while the user reads, not only as each stretch comes back enrolled.
    let chain = Promise.resolve(), fresh = true, done = false, saved = 0, heard = -1;
    const finish = () => { if (done) return; done = true; setStop(null); void vad.then((v) => v.destroy()).finally(() => stream.getTracks().forEach((t) => t.stop())); void qc.invalidateQueries({ queryKey: voiceprintKey }); };
    const vad = MicVAD.new({
      model: cfg.vad.model,
      startOnLoad: false,
      baseAssetPath: "/vad/", // vendored by scripts/copy-voice-assets.mjs, as voiceEngine.ts's
      onnxWASMBasePath: "/vad/",
      getStream: async () => stream,
      positiveSpeechThreshold: cfg.vad.speechThreshold,
      negativeSpeechThreshold: Math.max(0.1, cfg.vad.speechThreshold - 0.15),
      minSpeechMs: 250,
      redemptionMs: cfg.vad.redemptionMs,
      onSpeechStart: () => { heard = 0; },
      onFrameProcessed: (_p, frame) => { if (heard >= 0 && !done) setState({ seconds: saved + (heard += frame.length / 16000) }); },
      onVADMisfire: () => { heard = -1; setState({ seconds: saved }); },
      onSpeechEnd: (audio) => {
        heard = -1;
        chain = chain.then(async () => {
          if (done) return;
          const s = await enrollVoice(audio, mic, fresh);
          fresh = false;
          if (!s) { setState((p) => ({ seconds: p?.seconds ?? 0, error: "The agent didn't take the recording. Is the model downloaded?" })); return finish(); }
          const seconds = saved = s.prints.find((p) => p.mic === mic)?.seconds ?? 0;
          setState({ seconds: seconds + Math.max(0, heard) });
          if (seconds >= ENROLL_S) finish();
        });
      },
    });
    setStop(() => finish);
    try { await (await vad).start(); } catch { setState({ seconds: 0, error: "Couldn't start listening." }); finish(); }
    if (unmounted.current) finish();
  };
  useEffect(() => () => stop?.(), [stop]); // leaving Settings mid-recording closes the mic
  return { state, recording: !!stop, start: () => void start(), stop: () => stop?.() };
}

/** The voiceprint (lib/live/voiceprint.ts): its mode, its model on the agent,
 *  and the user's enrollment, kept on this machine and deletable here. */
function VoiceprintPicker({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const qc = useQueryClient();
  const { isError, data: engines } = useNativeEngines();
  const { data: status } = useQuery({ queryKey: voiceprintKey, queryFn: voiceprintStatus, enabled: cfg.voiceprint !== "off" });
  const enrollment = useEnrollment(cfg);
  const model = variantStatus(engines, VOICEPRINT_ENGINE);
  const forget = async () => { await forgetVoiceprint(); void qc.invalidateQueries({ queryKey: voiceprintKey }); toast("Voiceprint deleted.", "info"); };
  const on = cfg.voiceprint !== "off" && !isError;
  return (
    <div id="set-engine-voiceprint" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-label text-foreground">Voiceprint</span>
        <Experimental />
        <InfoTip label={<>Tells your voice from others once you enroll. Phrases under about a second can&apos;t be checked, and in &ldquo;Only me&rdquo; a cut waits about 2 s to confirm it&apos;s you.</>} />
      </div>
      <fieldset disabled={isError} className="disabled:opacity-50">
        <Segmented label="Voiceprint (experimental)" className="grid w-full" options={VOICEPRINT_MODES_UI} value={cfg.voiceprint}
          onChange={(v) => update({ ...cfg, voiceprint: v })} />
      </fieldset>
      <p className="text-caption text-faint">
        {isError ? "Needs OpenLive's local agent, which the desktop app runs." : VOICEPRINT_COPY[cfg.voiceprint]}
      </p>
      {on && <NativeEngineRow id={VOICEPRINT_ENGINE} fallback="no voiceprint and hear everyone" />}
      {on && model && <p className="text-caption text-faint">{model.name} · {model.license}</p>}
      {on && model?.installed && (
        <div className="space-y-2 rounded-lg bg-card px-card-x py-3 shadow-card">
          {enrollment.recording ? (
            <>
              <p className="text-label text-foreground">Read this aloud at your normal pace:</p>
              <p className="text-body text-muted-foreground">{ENROLL_TEXT}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (100 * (enrollment.state?.seconds ?? 0)) / ENROLL_S)}%` }} />
              </div>
              <Button size="sm" onClick={enrollment.stop}><X /> Stop</Button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-label text-muted-foreground">
                {status?.enrolled ? `Enrolled on ${status.prints.map((p) => p.mic || "the default mic").join(", ")}.` : "Not enrolled yet: until you are, everyone is heard."}
              </span>
              <Button size="sm" onClick={enrollment.start}><Mic /> {status?.enrolled ? "Enroll again on this mic" : "Enroll my voice"}</Button>
              {!!status?.prints.length && <Button size="sm" onClick={() => void forget()} className="enabled:hover:text-danger"><Trash2 /> Delete voiceprint</Button>}
            </div>
          )}
          {enrollment.state?.error && <p role="alert" className="text-caption text-danger">{enrollment.state.error}</p>}
          <p className="flex items-center gap-1.5 text-caption text-faint">
            Stays on this computer.
            <InfoTip label={`About ${ENROLL_S} seconds of your voice, turned into numbers that stay on this computer. Later turns that are clearly you keep it up to date, and a new mic gets its own.`} />
          </p>
        </div>
      )}
    </div>
  );
}

function MicStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  return (
    <div className="space-y-4">
      <StageHead title="Voice detection" desc="Hears when you start and stop talking, and lets you cut in. Runs in the app; a change applies from the next conversation." />
      <div className={ENGINE_GRID}>
        {VAD_MODELS.map((m) => (
          <EngineChoice key={m.id} id={m.id} active={cfg.vad.model === m.id} note="MIT" where="In the app"
            onPick={() => update({ ...cfg, vad: { ...cfg.vad, model: m.id } })} />
        ))}
      </div>
      <Advanced id="engine:mic">
        <Slider label="Speech sensitivity" hint="Lower picks up softer speech and barges in faster." value={cfg.vad.speechThreshold} min={0.1} max={0.9} step={0.05}
          format={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, speechThreshold: v } })} />
        <Slider label="Trailing silence" hint="How long a pause runs before your turn ends. Wait before answering in Voice sets it too." value={cfg.vad.redemptionMs} min={200} max={1500} step={50}
          format={(v) => `${v} ms`} onChange={(v) => update({ ...cfg, vad: { ...cfg.vad, redemptionMs: v } })} />
        <VoiceprintPicker cfg={cfg} update={update} />
      </Advanced>
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
      <StageHead title="Speech-to-text" desc="Turns what you say into text, on this device. Pick one; the rest stay off your disk until you download them. Applies on the next call." />
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
      {whisper ? <ModelStatus removeKind="whisper" /> : <NativeEngineRow id={cfg.stt.variant} fallback="Whisper" accel={false} />}
      <Advanced id="engine:stt">
        {whisper && <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-label text-foreground">
            <label htmlFor="set-engine-whisper-size">Whisper model size</label>
            <InfoTip label="Bigger hears better and takes longer to answer. English runs the English-only build of each size; any other language loads the multilingual build of the same size, automatically." />
          </span>
          <Select id="set-engine-whisper-size" value={cfg.stt.whisperSize} onChange={(e) => update({ ...cfg, stt: { ...cfg.stt, whisperSize: e.target.value as PipelineConfig["stt"]["whisperSize"] } })} className="w-full">
            {WHISPER_SIZES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>}
        {!whisper && <VariantPicker cfg={cfg} stage="stt" update={update} onAsk={ask} />}
        {!whisper && <AccelRow id={cfg.stt.variant} />}
        {whisper && !hasWebGPU() && <p className="-mt-2 text-caption text-faint">WebGPU isn&apos;t available here, so calls run the Tiny model regardless. The size choice applies when WebGPU is.</p>}
        {whisper && cfg.stt.whisperSize === "large-v3-turbo" && <p className="-mt-2 text-caption text-faint">A big download and a real GPU-memory footprint: expect the best transcription, but drop back to Small if your machine struggles.</p>}
      </Advanced>
    </div>
  );
}

const SIDE_TALK_UI: SegOption<SideTalk>[] = [{ id: "off", label: "Off" }, { id: "shadow", label: "Judge only" }, { id: "ignore", label: "Ignore side talk" }];
const SIDE_TALK_COPY: Record<SideTalk, string> = {
  off: "Everything you say while the mic is on is taken as said to the agent.",
  shadow: "Every sentence is judged, and every one still gets an answer: nothing is dropped. For the judgment log below, with no risk of a missed turn.",
  ignore: "A sentence that sounds said to someone else in the room (\"did you feed the dog?\") gets no answer, and a reply it paused goes on. The transcript shows it, with a button to send it anyway. When unsure, it answers. Push-to-talk, and answers to the agent's questions, always go through.",
};
const addresseeKey = ["addressee"];

/** Side talk (lib/live/addressee.ts): whether a sentence said to someone else
 *  in the room is dropped, its model on the agent, and the judgment log
 *  (opt-in, on this machine, deletable here) that trains the user's own head. */
function SideTalkPicker({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const qc = useQueryClient();
  const { isError, data: engines } = useNativeEngines();
  const model = variantStatus(engines, ADDRESSEE_ENGINE);
  const on = cfg.sideTalk !== "off" && !isError;
  const { data: status } = useQuery({ queryKey: addresseeKey, queryFn: addresseeStatus, enabled: on });
  const forget = async () => { await deleteJudgmentLog(); void qc.invalidateQueries({ queryKey: addresseeKey }); toast("Judgment log deleted.", "info"); };
  return (
    <div id="set-engine-side-talk" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-label text-foreground">Side talk</span>
        <Experimental />
        <InfoTip label={<>Tries to tell when you&apos;re talking to someone else in the room. It catches only part of side talk today, about one in five English sentences in our tests. &ldquo;Judge only&rdquo; collects data and changes nothing.</>} />
      </div>
      <fieldset disabled={isError} className="disabled:opacity-50">
        <Segmented label="Side talk (experimental)" className="grid w-full" options={SIDE_TALK_UI} value={cfg.sideTalk}
          onChange={(v) => update({ ...cfg, sideTalk: v })} />
      </fieldset>
      <p className="text-caption text-faint">
        {isError ? "Needs OpenLive's local agent, which the desktop app runs." : SIDE_TALK_COPY[cfg.sideTalk]}
      </p>
      {on && <NativeEngineRow id={ADDRESSEE_ENGINE} fallback="no check and answer everything" />}
      {on && model && <p className="text-caption text-faint">{model.name} · {model.license}{status?.head === "personal" && " · judging with your own trained head"}</p>}
      {on && (
        <div className="space-y-2 rounded-lg bg-card px-card-x py-3 shadow-card">
          <label className="flex cursor-pointer select-none items-start gap-2.5">
            <Switch on={cfg.sideTalkLog} onFlip={() => update({ ...cfg, sideTalkLog: !cfg.sideTalkLog })} className="mt-0.5" />
            <span className="flex items-center gap-1.5 text-label leading-snug text-foreground">
              Keep a judgment log to train on
              <InfoTip label={<>Each judged sentence&apos;s words, the reply before it, and how it sounded (loudness, pitch, pace, timing; never the audio), kept on this computer for <code>pnpm addressee:train</code>. &quot;Send it&quot; and &quot;Not for you&quot; in the transcript mark what it got wrong. The newest {status?.log.cap ?? 5000} are kept.</>} />
            </span>
          </label>
          {!!status?.log.count && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-label text-muted-foreground">{status.log.count} judged, {status.log.labelled} marked by you.</span>
              <Button size="sm" onClick={() => void forget()} className="enabled:hover:text-danger"><Trash2 /> Delete log and trained head</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TurnStage({ cfg, update }: { cfg: PipelineConfig; update: Update }) {
  const go = useSettingsNav();
  const preset = activeTurnPreset(cfg);
  return (
    <div className="space-y-4">
      <StageHead title="Turn-taking" desc="Decides when you have finished talking. Smart-Turn reads the sense of your last words; a silence timeout just waits out the pause." />
      <div className="rounded-lg bg-card px-card-x shadow-card">
        <LinkRow label="Wait before answering" detail="Patient, Even and Quick move the timings below together."
          value={`${TURN_PRESETS.find((p) => p.id === preset)?.name ?? "Custom"} · set in Voice`} onGo={() => go("voice", "set-voice-wait")} />
      </div>
      <div className={ENGINE_GRID}>
        {TURN_ENGINES.map((t) => (
          <EngineChoice key={t.id} id={t.id} active={cfg.turn.engine === t.id} where={t.id === "silence" ? "Built in" : "In the app"}
            onPick={() => update({ ...cfg, turn: { ...cfg.turn, engine: t.id } })} />
        ))}
      </div>
      <Advanced id="engine:turn">
        {cfg.turn.engine === "smart-turn" && (
            <Slider label="End-of-turn threshold" hint="Higher waits longer (fewer interruptions); lower replies sooner." value={cfg.turn.threshold} min={0} max={1} step={0.05}
              format={(v) => v.toFixed(2)} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, threshold: v } })} />
        )}
        <Slider label="Mid-thought hold" hint={<>How long a &ldquo;not finished yet&rdquo; pause is held before it auto-sends. You can always tap &ldquo;send now&rdquo; (or press Enter) instead of waiting.</>} value={cfg.turn.holdMs} min={1000} max={8000} step={500}
          format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => update({ ...cfg, turn: { ...cfg.turn, holdMs: v } })} />
        <SideTalkPicker cfg={cfg} update={update} />
      </Advanced>
    </div>
  );
}

export const SAMPLE = "Hi! This is how I sound in a live conversation.";

/** Play `text` as a live reply would sound with `cfg`: normalized, respelled
 *  by the dictionary, in the chosen voice. Loads the browser models first when
 *  the voice is one of them. */
export async function playPreview(text: string, cfg: PipelineConfig) {
  if (!isNativeVariant(cfg.tts.variant) && !modelsReady()) await loadModels(() => {}, "settings");
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
  const { data: engines } = useNativeEngines();
  const where = useWhereItRuns();
  const native = isNativeVariant(cfg.tts.variant);
  const missing = missingNote(cfg, "tts", engines);
  // This browser voice's copy on the agent, when the agent has one that runs here.
  const copy = native ? undefined : engines?.find((f) => f.browser === cfg.tts.family)?.variants.find((v) => v.runnable);
  const engine = familyInfo("tts", cfg.tts.family) ?? TTS_FAMILIES[0]!;
  // Switching engines swaps the voice list too: chooseFamily snaps the voice to
  // the new engine's default, which Voice then shows.
  const { pick, ask, gate } = useFamilyPick(cfg, "tts", update);
  const standIn = familyInfo("tts", browserTtsFallback(cfg.language) ?? "")?.name ?? "no voice";
  return (
    <div className="space-y-4">
      <StageHead title="Text-to-speech" desc="The engine that speaks replies, on this device. The voice itself and its speed are chosen in Voice. Applies to the next reply." />
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
      {native ? <NativeEngineRow id={cfg.tts.variant} fallback={standIn} accel={false} />
        : <ModelStatus removeKind={cfg.tts.family === "supertonic" ? "supertonic" : cfg.tts.family === "kokoro" ? "kokoro" : undefined} />}
      <Advanced id="engine:tts">
        <VariantPicker cfg={cfg} stage="tts" update={update} onAsk={ask} />
        {native && <AccelRow id={cfg.tts.variant} />}
        {copy && (
          <div className="space-y-2">
            <p className="text-label text-foreground">On this computer</p>
            <p className="text-caption text-faint">
              {engine.name} can also run in OpenLive&apos;s agent, on this computer&apos;s CPU or GPU, whichever it measures faster here. Same voice; the browser copy above stays the fallback. {mb(copy.sizeBytes)}, {copy.license}.
            </p>
            <NativeEngineRow id={copy.id} fallback={`${engine.name} in the browser`} />
          </div>
        )}
        {!native && !copy && engine.variants.length < 2 && <p className="text-caption text-faint">{engine.name} has nothing to tune.</p>}
      </Advanced>
    </div>
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
      <Button variant="primary" size="sm" onClick={() => void downloadEngine(e, qc)}>
        <Download /> Download ({mb(e.sizeBytes)})
      </Button>
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
      <Select aria-label="Language" value={cfg.language} onChange={(e) => choose(e.target.value as LanguageCode)} className="w-full max-w-md">
        {CURATED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{languageLabel(l.code)}</option>)}
      </Select>
      {notice && (
        <Notice role="status" className="max-w-xl flex-col">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-medium">Switched to {languageLabel(notice.lang)}, so some engines changed:</p>
            <Tooltip label="Dismiss" className="-my-1 -mr-1.5">
              <Button variant="ghost" size="sm" icon onClick={() => setNotice(null)} aria-label="Dismiss" className="text-arc-text"><X /></Button>
            </Tooltip>
          </div>
          {notice.lines.map((n) => (
            <div key={n.text} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 break-words">{n.text}</span>
              {n.download && <NoticeDownload id={n.download} />}
            </div>
          ))}
        </Notice>
      )}
    </div>
  );
}

export function PipelineSettings() {
  const [cfg, setCfg] = useState<PipelineConfig>(() => loadPipelineConfig());
  const [stage, setStage] = useState<StageId>("mic");
  // A shorter stage must not scroll the page: the new one starts at the old one's
  // height (keepScroll), and the floor goes once it would move nothing.
  const stageBox = useRef<HTMLDivElement>(null);
  const floor = useRef(0);
  const pickStage = (s: StageId) => { if (s !== stage) floor.current = holdFloor(stageBox.current); setStage(s); };
  useLayoutEffect(() => {
    const box = stageBox.current;
    if (!box || !floor.current) return;
    return releaseWhenFree(box, floor.current);
  }, [stage]);
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
      <div id="set-engine-device" className="flex flex-col gap-3">
        <DeviceSummary />
        <Segmented label="Pipeline stage" anchor="set-engine-stage" className="grid w-full"
          options={STAGES} value={stage} onChange={pickStage} />
      </div>

      <div ref={stageBox}>
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
          <button onClick={() => update({ ...cfg, allowRestricted: false })} className="hit text-muted-foreground underline underline-offset-2 hover:text-foreground">Lock them again</button>
          {" "}(the engines in use keep working).
        </p>
      )}
      <Button id="set-engine-reset" size="sm" onClick={reset} className="self-start">
        <RotateCcw /> Reset to defaults
      </Button>
    </div>
  );
}
