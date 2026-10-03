"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, Mic, Pencil, Play, RotateCcw, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { stt, modelsReady, loadModels, downloadModel, agreeTo, ModelsNotDownloaded } from "@/lib/live/models";
import type { WeightFile } from "@/lib/live/weights";
import { DownloadOffer } from "@/components/live/DownloadOffer";
import { loadPipelineConfig, savePipelineConfig, onPipelineConfig, chooseVariant, familyInfo, LANGUAGE_DEFAULTS } from "@/lib/live/pipelineConfig";
import { AllowRestricted } from "./PipelineSettings";
import { deferDelete, usePendingDeletes } from "@/lib/deferredDelete";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { cn } from "@/lib/cn";
import { Segmented, Checkbox, Button, Tooltip, Input, Badge, Textarea } from "@/components/ui";
import { Section } from "./Section";
import { AudioBar } from "./AudioBar";

// Your voices, the cloning half of the Voice tab. Clone a voice from a short recording
// and manage the results: record → listen back → transcript → save, then
// preview with any text, rename, export/import, set as the speaking voice.
// Synthesis runs in the local agent service (ZipVoice via sherpa-onnx; its weights
// are restricted, so all of this waits for the user's OK, pipelineConfig.ts `restricted`);
// nothing recorded or spoken ever leaves the machine.

export interface VoiceProfile { id: string; name: string; transcript: string; createdAt: string; seconds?: number }
interface ModelState { installed: boolean; downloading: boolean; downloadBytes: number; diskBytes: number }

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const MIN_SEC = 5, MAX_SEC = 30;

const SCRIPTS = [
  { id: "everyday", label: "Everyday", text: "Hey, it's me. I'm recording a short sample so my computer can speak in my voice. I talk to it about work, plans for the weekend, and whatever else comes up during the day." },
  { id: "expressive", label: "Expressive", text: "Okay, this is exciting! The quick brown fox jumps over the lazy dog. But honestly? I never understood why foxes get all the credit. Anyway, let's see how this sounds." },
  { id: "calm", label: "Calm", text: "The evening settles in slowly. I like reading a few pages before bed, with some quiet music in the background. Everything stays on this machine, which is exactly how I want it." },
] as const;

/** Float32 PCM → 16-bit mono WAV bytes. */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true);
  return new Uint8Array(buf);
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const getJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
};

/** Float32 PCM → object URL playable by AudioBar. Caller revokes when done. */
const pcmUrl = (samples: Float32Array, sampleRate: number) =>
  URL.createObjectURL(new Blob([encodeWav(samples, sampleRate) as BlobPart], { type: "audio/wav" }));

export function VoicesSettings() {
  const qc = useQueryClient();
  const { data: model, isError: modelError, refetch: retryModel } = useQuery<ModelState>({ queryKey: ["voice-model"], queryFn: () => getJson("/api/voice/model"), retry: 1 });
  const { data: allProfiles = [] } = useQuery<VoiceProfile[]>({ queryKey: ["voice-profiles"], queryFn: () => getJson("/api/voice/profiles") });
  const pending = usePendingDeletes((s) => s.keys);
  const profiles = allProfiles.filter((p) => !pending.has(`voice:${p.id}`));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["voice-model"] }); void qc.invalidateQueries({ queryKey: ["voice-profiles"] }); };
  const [cfg, setCfg] = useState(loadPipelineConfig);
  useEffect(() => onPipelineConfig(setCfg), []);
  const desc = <>A one-time, deletable download: ZipVoice (code Apache-2.0, weights unlicensed) running <span className="text-foreground">entirely on this machine</span>. English and Chinese. Only clone your own voice, or one you have clear permission to use.</>;

  if (!cfg.allowRestricted) return (
    <Section title="Cloning engine" desc={desc}>
      <AllowRestricted family={familyInfo("tts", "clone")!} onAllow={() => setCfg(savePipelineConfig({ ...cfg, allowRestricted: true }))} />
    </Section>
  );
  return (
    <div className="flex flex-col gap-7">
      <Section title="Cloning engine" desc={desc}>
        <ModelCard model={model} failed={modelError} onRetry={() => void retryModel()} onChange={refresh} />
      </Section>

      {model?.installed && (
        <Section title="Create a voice" desc={`Record ${MIN_SEC}–${MAX_SEC} seconds (read a script or just talk), or upload an existing clip. You'll hear it back before anything is saved.`}>
          <Recorder onSaved={refresh} />
        </Section>
      )}

      {model?.installed && (
        <Section title="Your voices" desc="Preview with any text, set one as the speaking voice, rename, or move profiles between machines.">
          <ProfileManager profiles={profiles} onChange={refresh} />
        </Section>
      )}
    </div>
  );
}

// ── model install / remove ───────────────────────────────────────────────────
function ModelCard({ model, failed, onRetry, onChange }: { model?: ModelState; failed: boolean; onRetry: () => void; onChange: () => void }) {
  const [progress, setProgress] = useState<number | null>(null);

  const download = async () => {
    setProgress(0);
    try {
      await downloadModel("/api/voice/model/download", (loaded, total) => setProgress(loaded / total));
      toast("Cloning engine installed. Record your first voice below.", "info");
    } catch (e) {
      log.error("voice", "model download:", e);
      toast(`Download failed: ${String((e as Error)?.message ?? e)}`);
    } finally { setProgress(null); onChange(); }
  };

  const remove = async () => {
    await fetch("/api/voice/model", { method: "DELETE" }).catch(() => {});
    onChange();
    toast("Cloning engine removed, disk space freed. Your saved profiles remain.", "info");
  };

  if (!model && failed) return (
    <div className="flex items-center gap-3" role="alert">
      <span className="text-label text-muted-foreground">Couldn&apos;t reach the voice engine. Is OpenLive&apos;s agent running?</span>
      <Button size="sm" onClick={onRetry}><RotateCcw /> Retry</Button>
    </div>
  );
  if (!model) return <p className="text-label text-muted-foreground">Checking…</p>;
  if (progress !== null || model.downloading) return (
    <div className="flex max-w-md flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
      </div>
      <p className="text-caption text-faint">Downloading… {Math.round((progress ?? 0) * 100)}% of {mb(model.downloadBytes)}</p>
    </div>
  );
  return model.installed ? (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-label text-success"><Check className="size-3.5" /> Installed · {mb(model.diskBytes)} on disk</span>
      <Button size="sm" onClick={remove}><Trash2 /> Remove</Button>
    </div>
  ) : (
    <div className="flex items-center gap-3">
      <Button variant="primary" onClick={download}><Download /> Download ({mb(model.downloadBytes)})</Button>
      <span className="text-caption text-faint">Removable anytime; profiles are tiny and kept separately.</span>
    </div>
  );
}

// ── guided recorder: record → listen back → details → save ──────────────────
type Take = { samples: Float32Array; sampleRate: number };

function Recorder({ onSaved }: { onSaved: () => void }) {
  const [scriptId, setScriptId] = useState<(typeof SCRIPTS)[number]["id"]>("everyday");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const meter = useRef<HTMLDivElement>(null);
  const [take, setTake] = useState<Take | null>(null);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"transcribe" | "save" | "decode" | null>(null);
  // Transcribing needs Whisper, which is asked about here before it downloads.
  const [needs, setNeeds] = useState<WeightFile[] | null>(null);
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; raf: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (rec.current) stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen-back URL for the current take; revoked when the take changes or on unmount.
  useEffect(() => {
    if (!take) { setTakeUrl(null); return; }
    const url = pcmUrl(take.samples, take.sampleRate);
    setTakeUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [take]);

  const stop = () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    cancelAnimationFrame(r.raf);
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    const total = r.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0; for (const c of r.chunks) { samples.set(c, o); o += c.length; }
    const sampleRate = r.ctx.sampleRate;
    void r.ctx.close();
    setRecording(false);
    acceptTake(samples, sampleRate);
  };

  // A captured OR uploaded clip: enforce the length window, then auto-transcribe
  // with the on-device Whisper (editable afterwards). Shared by record + upload.
  const acceptTake = (samples: Float32Array, sampleRate: number) => {
    if (samples.length / sampleRate < MIN_SEC) { setBusy(null); toast(`Too short. It needs at least ${MIN_SEC} seconds.`); return; }
    const capped = samples.length / sampleRate > MAX_SEC ? samples.subarray(0, Math.floor(MAX_SEC * sampleRate)) : samples;
    setTake({ samples: capped, sampleRate });
    void transcribe(capped, sampleRate);
  };
  const transcribe = async (samples: Float32Array, sampleRate: number) => {
    setBusy("transcribe");
    setNeeds(null);
    try {
      if (!modelsReady()) await loadModels(() => {}, "settings");
      const ratio = sampleRate / 16000; // Whisper expects 16 kHz: a cheap linear resample
      const out = new Float32Array(Math.floor(samples.length / ratio));
      for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)]!;
      const { text } = await stt(out, undefined, true);
      if (text.trim()) setTranscript(text.trim());
    } catch (e) {
      if (e instanceof ModelsNotDownloaded) setNeeds(e.missing);
      else log.error("voice", "reference transcribe:", e);
    } finally { setBusy(null); }
  };

  // Clone from an existing recording: decode any browser-supported audio file to
  // mono PCM and run it through the same listen-back → transcript → save flow.
  const onFile = async (file: File) => {
    setBusy("decode");
    try {
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(await file.arrayBuffer());
      void ctx.close();
      const n = audio.length, ch = audio.numberOfChannels;
      const data = Array.from({ length: ch }, (_, c) => audio.getChannelData(c));
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) { let sum = 0; for (let c = 0; c < ch; c++) sum += data[c]![i]!; mono[i] = sum / ch; }
      setTranscript(""); setName("");
      acceptTake(mono, audio.sampleRate); // hands the busy state off to "transcribe"
    } catch (e) { log.error("voice", "decode:", e); toast("Couldn't read that audio. Try a WAV, MP3, or M4A file."); setBusy(null); }
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(node); node.connect(ctx.destination);
      const startedAt = Date.now();
      const tick = () => {
        if (!rec.current) return;
        const sec = (Date.now() - startedAt) / 1000;
        // Whole seconds only: a render a second, not a frame. The level goes straight to the DOM.
        setSeconds(Math.floor(sec));
        const last = chunks[chunks.length - 1];
        const level = last ? Math.min(1, Math.sqrt(last.reduce((s, x) => s + x * x, 0) / last.length) * 8) : 0;
        if (meter.current) meter.current.style.transform = `scaleX(${level})`;
        if (sec >= MAX_SEC) { stop(); return; }
        rec.current.raf = requestAnimationFrame(tick);
      };
      rec.current = { ctx, stream, node, chunks, raf: 0 };
      setTake(null); setTranscript(""); setSeconds(0); setRecording(true);
      rec.current.raf = requestAnimationFrame(tick);
    } catch { toast("Microphone access is needed to record a voice sample."); }
  };

  const save = async () => {
    if (!take) return;
    setBusy("save");
    try {
      const wav = encodeWav(take.samples, take.sampleRate);
      const res = await fetch("/api/voice/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "My voice", transcript: transcript.trim(), wavBase64: b64(wav), consent }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      setTake(null); setTranscript(""); setName(""); setConsent(false);
      toast("Voice saved. Set it as the speaking voice below, or preview it first.");
      onSaved();
    } catch (e) { toast(`Couldn't save the voice: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
  };

  const script = SCRIPTS.find((s) => s.id === scriptId)!;
  // A second ahead: the bar spends each second gliding to where the next tick lands.
  const progressPct = Math.min(100, ((seconds + 1) / MAX_SEC) * 100);
  const minPct = (MIN_SEC / MAX_SEC) * 100;

  // Step 1 — record
  if (!take) return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-card p-4 shadow-card">
      <div className="flex items-center gap-1.5">
        <Segmented label="Script to read" size="sm" options={SCRIPTS} value={scriptId} onChange={setScriptId} />
        <span className="ml-auto text-caption text-faint">or just talk naturally</span>
      </div>
      <p className="rounded-lg bg-surface p-3 text-body leading-relaxed text-foreground">{script.text}</p>
      <div className="flex items-center gap-3">
        <Button variant={recording ? "destructive" : "primary"} onClick={recording ? stop : start}>
          {recording ? <Square /> : <Mic />}
          {recording ? "Stop" : "Start recording"}
        </Button>
        {recording ? (
          <div className="flex flex-1 items-center gap-2.5">
            {/* elapsed bar with the minimum-length marker */}
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
              <div className={cn("h-full origin-left rounded-full transition-transform duration-1000 ease-linear", seconds >= MIN_SEC ? "bg-success" : "bg-arc")}
                style={{ transform: `scaleX(${progressPct / 100})` }} />
              <Tooltip label={`${MIN_SEC}s minimum`}><div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${minPct}%` }} /></Tooltip>
            </div>
            <span className="w-16 text-right font-mono text-caption tabular-nums text-muted-foreground">{seconds.toFixed(0)}s / {MAX_SEC}s</span>
            <Tooltip label="Input level">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
                <div ref={meter} className="h-full origin-left scale-x-0 rounded-full bg-accent transition-transform duration-meter" />
              </div>
            </Tooltip>
          </div>
        ) : (
          <span className="text-caption text-faint">{MIN_SEC}–{MAX_SEC} seconds · quiet room, normal speaking distance</span>
        )}
      </div>
      {/* Or clone from an existing recording instead of the mic. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
        <input ref={fileInput} type="file" accept="audio/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={recording || busy !== null}>
          {busy === "decode" ? <Loader2 className="animate-spin" /> : <Upload />}
          {busy === "decode" ? "Reading…" : "Upload an audio file"}
        </Button>
        <span className="text-caption text-faint">Have a clean {MIN_SEC}–{MAX_SEC}s clip already? WAV, MP3, or M4A.</span>
      </div>
    </div>
  );

  // Step 2 — listen back + details + save
  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-card p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="text-label text-muted-foreground">Listen back: {(take.samples.length / take.sampleRate).toFixed(0)}s recorded</span>
        <Button size="sm" onClick={() => { setTake(null); setTranscript(""); }} className="ml-auto">
          <RotateCcw /> Re-record
        </Button>
      </div>
      {takeUrl && <AudioBar src={takeUrl} />}
      {needs && (
        <DownloadOffer title="Download speech recognition to fill in the transcript?" meanwhile="Or type what you said below." files={needs} state="ask"
          yes="Download and transcribe" onYes={() => { agreeTo(needs); void transcribe(take.samples, take.sampleRate); }} onNo={() => setNeeds(null)} />
      )}
      <label className="flex flex-col gap-1">
        <span className="text-caption text-muted-foreground">{busy === "transcribe" ? "Transcribing…" : "Transcript: fix anything Whisper misheard, since cloning quality depends on it."}</span>
        <Textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} placeholder="What you said, word for word" />
      </label>
      <div className="flex items-center gap-2">
        <Input size="md" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="Voice name (e.g. Me)" aria-label="Voice name"
          className="flex-1" />
        <Button variant="primary" onClick={save} disabled={!consent || !transcript.trim() || busy !== null}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save voice
        </Button>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-caption leading-snug text-muted-foreground">
        <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        This is my own voice, or I have this person&apos;s permission. Cloned speech is generated on this device only.
      </label>
    </div>
  );
}

// ── profile manager: preview with any text, use, listen, rename, export/import ─
const DEFAULT_PREVIEW = "Hi! This is how I sound as your assistant.";

function ProfileManager({ profiles, onChange }: { profiles: VoiceProfile[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  // The clip currently loaded in a card's player: a synthesized preview or the
  // original recording. One at a time; swapping revokes the old URL.
  const [clip, setClip] = useState<{ id: string; kind: "preview" | "original"; url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Held in state so the active badge moves the moment a voice is chosen or removed.
  const [cfg, setCfg] = useState(loadPipelineConfig);
  const activeId = cfg.tts.family === "clone" ? cfg.tts.voice : null;
  useEffect(() => onPipelineConfig(setCfg), []);
  const qc = useQueryClient();

  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url); }, [clip]);

  const useVoice = (id: string) => {
    const clone = chooseVariant(cfg, "tts", "clone");
    setCfg(savePipelineConfig({ ...clone, tts: { ...clone.tts, voice: id } }));
    onChange();
    toast("Cloned voice active. It speaks from your next call.");
  };

  const preview = async (p: VoiceProfile) => {
    setBusy(`preview:${p.id}`);
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: previewText.trim() || DEFAULT_PREVIEW, profileId: p.id, speed: cfg.tts.speed }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const samples = new Float32Array(await res.arrayBuffer());
      setClip({ id: p.id, kind: "preview", url: pcmUrl(samples, Number(res.headers.get("x-sample-rate")) || 24000) });
    } catch (e) { toast(`Preview failed: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
  };

  const listen = async (p: VoiceProfile) => {
    setBusy(`listen:${p.id}`);
    try {
      const res = await fetch(`/api/voice/profiles/${p.id}/audio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setClip({ id: p.id, kind: "original", url: URL.createObjectURL(await res.blob()) });
    } catch { toast("Couldn't play the recording."); }
    finally { setBusy(null); }
  };

  const rename = async (p: VoiceProfile) => {
    const name = renameTo.trim();
    setRenaming(null);
    if (!name || name === p.name) return;
    await fetch(`/api/voice/profiles/${p.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {});
    onChange();
  };

  const exportProfile = async (p: VoiceProfile) => {
    const res = await fetch(`/api/voice/profiles/${p.id}/export`);
    if (!res.ok) { toast("Export failed."); return; }
    const blob = new Blob([await res.text()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `openlive-voice-${p.name.replace(/\W+/g, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importProfile = async (file: File) => {
    try {
      const res = await fetch("/api/voice/profiles/import", { method: "POST", headers: { "content-type": "application/json" }, body: await file.text() });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      toast("Voice imported.");
      onChange();
    } catch (e) { toast(`Import failed: ${String((e as Error)?.message ?? e)}`); }
  };

  // Deferred behind an Undo toast. The speaking voice only falls back to Kokoro
  // once the delete lands, read fresh then: it may have changed in the meantime.
  const remove = (p: VoiceProfile) => {
    if (clip?.id === p.id) setClip(null);
    deferDelete(`voice:${p.id}`, `Deleted “${p.name}”`, async () => {
      const r = await fetch(`/api/voice/profiles/${p.id}`, { method: "DELETE", keepalive: true });
      if (!r.ok) return false;
      const now = loadPipelineConfig();
      if (now.tts.family === "clone" && now.tts.voice === p.id) savePipelineConfig(chooseVariant(now, "tts", LANGUAGE_DEFAULTS[now.language].tts));
      await qc.invalidateQueries({ queryKey: ["voice-profiles"] });
    }, `Couldn’t delete “${p.name}”. It’s back in your voices.`);
  };

  return (
    <div className="flex max-w-xl flex-col gap-3">
      {profiles.length > 0 && (
        <Input size="md" value={previewText} onChange={(e) => setPreviewText(e.target.value.slice(0, 200))}
          placeholder={`Preview text: try anything (default: “${DEFAULT_PREVIEW}”)`} aria-label="Preview text" />
      )}

      {profiles.length === 0 && <p className="text-label text-faint">No voices yet. Record one above, or import a profile.</p>}

      {profiles.map((p) => (
        <div key={p.id} className={cn("flex flex-col gap-2 rounded-xl bg-card p-3 shadow-card transition", p.id === activeId && "ring-2 ring-inset ring-accent")}>
          <div className="flex items-center gap-2">
            {renaming === p.id ? (
              <Input size="sm" autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value.slice(0, 60))} aria-label="Voice name"
                onBlur={() => void rename(p)} onKeyDown={(e) => { if (e.key === "Enter") void rename(p); if (e.key === "Escape") setRenaming(null); }}
                className="flex-1 font-medium" />
            ) : (
              <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                {p.name}
                {p.id === activeId && <Badge tone="accent" className="ml-2">Speaking voice</Badge>}
              </span>
            )}
            <span className="shrink-0 text-caption text-faint">{p.seconds ? `${p.seconds.toFixed(0)}s · ` : ""}{new Date(p.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => preview(p)} disabled={busy !== null}>
              {busy === `preview:${p.id}` ? <Loader2 className="animate-spin" /> : <Play />} Preview
            </Button>
            {p.id !== activeId && (
              <Button variant="primary" size="sm" onClick={() => useVoice(p.id)}>
                <Volume2 /> Use this voice
              </Button>
            )}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconAction label="Play the original recording" onClick={() => listen(p)} busy={busy === `listen:${p.id}`} icon={Volume2} />
            <IconAction label="Rename" onClick={() => { setRenaming(p.id); setRenameTo(p.name); }} icon={Pencil} />
            <IconAction label="Export to a file" onClick={() => exportProfile(p)} icon={Download} />
            <IconAction label="Delete" onClick={() => remove(p)} icon={Trash2} danger />
          </div>
          {clip?.id === p.id && (
            <div className="flex items-center gap-2">
              <AudioBar src={clip.url} autoPlay className="flex-1" />
              <span className="shrink-0 text-micro text-faint">{clip.kind === "preview" ? "Preview" : "Original recording"}</span>
            </div>
          )}
        </div>
      ))}

      <div>
        <input ref={fileInput} type="file" accept="application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProfile(f); e.target.value = ""; }} />
        <Button size="sm" onClick={() => fileInput.current?.click()}>
          <Upload /> Import a voice file
        </Button>
      </div>
    </div>
  );
}

function IconAction({ label, onClick, icon: Icon, busy, danger }: { label: string; onClick: () => void; icon: typeof Play; busy?: boolean; danger?: boolean }) {
  return (
    <Tooltip label={label}>
      <Button variant="ghost" size="sm" icon onClick={onClick} aria-label={label} className={cn(danger && "enabled:hover:text-danger")}>
        {busy ? <Loader2 className="animate-spin" /> : <Icon />}
      </Button>
    </Tooltip>
  );
}
