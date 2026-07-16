"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, Mic, Pencil, Play, RotateCcw, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { stt, modelsReady, loadModels } from "@/lib/live/models";
import { loadPipelineConfig, savePipelineConfig } from "@/lib/live/pipelineConfig";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { cn } from "@/lib/cn";
import { Section } from "./Section";

// Voices — the standalone Voice Studio. Clone a voice from a short recording
// and manage the results: record → listen back → transcript → save, then
// preview with any text, rename, export/import, set as the speaking voice.
// Synthesis runs in the local agent service (ZipVoice, Apache-2.0, sherpa-onnx);
// nothing recorded or spoken ever leaves the machine.

export interface VoiceProfile { id: string; name: string; transcript: string; createdAt: string; seconds?: number }
interface ModelState { installed: boolean; downloading: boolean; downloadBytes: number; diskBytes: number }

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const MIN_SEC = 5, MAX_SEC = 30;

const SCRIPTS = [
  { id: "everyday", label: "Everyday", text: "Hey, it's me. I'm recording a short sample so my computer can speak in my voice. I talk to it about work, plans for the weekend, and whatever else comes up during the day." },
  { id: "expressive", label: "Expressive", text: "Okay, this is exciting! The quick brown fox jumps over the lazy dog — but honestly? I never understood why foxes get all the credit. Anyway, let's see how this sounds." },
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

/** Play Float32 PCM once through a throwaway context. Returns a stop handle. */
function playPcm(samples: Float32Array, sampleRate: number, onEnd?: () => void): () => void {
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  buf.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  src.onended = () => { void ctx.close(); onEnd?.(); };
  return () => { try { src.stop(); } catch { /* already done */ } };
}

export function VoicesSettings() {
  const qc = useQueryClient();
  const { data: model } = useQuery<ModelState>({ queryKey: ["voice-model"], queryFn: () => fetch("/api/voice/model").then((r) => r.json()) });
  const { data: profiles = [] } = useQuery<VoiceProfile[]>({ queryKey: ["voice-profiles"], queryFn: () => fetch("/api/voice/profiles").then((r) => r.json()) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["voice-model"] }); void qc.invalidateQueries({ queryKey: ["voice-profiles"] }); };

  return (
    <div className="flex flex-col gap-7">
      <Section title="Cloning engine"
        desc={<>A one-time, deletable download — ZipVoice (Apache-2.0) running <span className="text-foreground">entirely on this machine</span>. English and Chinese. Only clone your own voice, or one you have clear permission to use.</>}>
        <ModelCard model={model} onChange={refresh} />
      </Section>

      {model?.installed && (
        <Section title="Create a voice" desc={`Record ${MIN_SEC}–${MAX_SEC} seconds in a quiet spot — read one of the scripts below or just talk. You'll hear it back before anything is saved.`}>
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
function ModelCard({ model, onChange }: { model?: ModelState; onChange: () => void }) {
  const [progress, setProgress] = useState<number | null>(null);

  const download = async () => {
    setProgress(0);
    try {
      const res = await fetch("/api/voice/model/download", { method: "POST" });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let buf = "";
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = JSON.parse(line) as { loaded?: number; total?: number; error?: string };
          if (m.error) throw new Error(m.error);
          if (m.loaded && m.total) setProgress(m.loaded / m.total);
        }
      }
      toast("Cloning engine installed — record your first voice below.");
    } catch (e) {
      log.error("voice", "model download:", e);
      toast(`Download failed: ${String((e as Error)?.message ?? e)}`);
    } finally { setProgress(null); onChange(); }
  };

  const remove = async () => {
    await fetch("/api/voice/model", { method: "DELETE" }).catch(() => {});
    onChange();
    toast("Cloning engine removed — disk space freed. Your saved profiles remain.");
  };

  if (!model) return <p className="text-[12px] text-muted-foreground">Checking…</p>;
  if (progress !== null || model.downloading) return (
    <div className="flex max-w-md flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
      </div>
      <p className="text-[11.5px] text-faint">Downloading… {Math.round((progress ?? 0) * 100)}% of {mb(model.downloadBytes)}</p>
    </div>
  );
  return model.installed ? (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-[12.5px] text-success"><Check className="size-3.5" /> Installed · {mb(model.diskBytes)} on disk</span>
      <button onClick={remove} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
        <Trash2 className="size-3.5" /> Remove
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-3">
      <button onClick={download} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-accent-foreground transition hover:opacity-90">
        <Download className="size-4" /> Download ({mb(model.downloadBytes)})
      </button>
      <span className="text-[11.5px] text-faint">Removable anytime; profiles are tiny and kept separately.</span>
    </div>
  );
}

// ── guided recorder: record → listen back → details → save ──────────────────
type Take = { samples: Float32Array; sampleRate: number };

function Recorder({ onSaved }: { onSaved: () => void }) {
  const [scriptId, setScriptId] = useState<(typeof SCRIPTS)[number]["id"]>("everyday");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [playing, setPlaying] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"transcribe" | "save" | null>(null);
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; raf: number } | null>(null);
  const stopPlayback = useRef<(() => void) | null>(null);

  useEffect(() => () => { stopPlayback.current?.(); if (rec.current) stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (total / sampleRate < MIN_SEC) { toast(`Too short — record at least ${MIN_SEC} seconds.`); return; }
    setTake({ samples, sampleRate });
    // Auto-transcribe with the on-device Whisper (editable afterwards).
    void (async () => {
      setBusy("transcribe");
      try {
        if (!modelsReady()) await loadModels(() => {});
        const ratio = sampleRate / 16000; // Whisper expects 16 kHz — cheap linear resample
        const out = new Float32Array(Math.floor(samples.length / ratio));
        for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)]!;
        const text = await stt(out);
        if (text.trim()) setTranscript(text.trim());
      } catch (e) { log.error("voice", "reference transcribe:", e); }
      finally { setBusy(null); }
    })();
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
        setSeconds(sec);
        const last = chunks[chunks.length - 1];
        setLevel(last ? Math.min(1, Math.sqrt(last.reduce((s, x) => s + x * x, 0) / last.length) * 8) : 0);
        if (sec >= MAX_SEC) { stop(); return; }
        rec.current.raf = requestAnimationFrame(tick);
      };
      rec.current = { ctx, stream, node, chunks, raf: 0 };
      stopPlayback.current?.();
      setTake(null); setTranscript(""); setSeconds(0); setRecording(true);
      rec.current.raf = requestAnimationFrame(tick);
    } catch { toast("Microphone access is needed to record a voice sample."); }
  };

  const togglePlayback = () => {
    if (playing) { stopPlayback.current?.(); setPlaying(false); return; }
    if (!take) return;
    setPlaying(true);
    stopPlayback.current = playPcm(take.samples, take.sampleRate, () => setPlaying(false));
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
      stopPlayback.current?.();
      setTake(null); setTranscript(""); setName(""); setConsent(false); setPlaying(false);
      toast("Voice saved. Set it as the speaking voice below, or preview it first.");
      onSaved();
    } catch (e) { toast(`Couldn't save the voice: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
  };

  const script = SCRIPTS.find((s) => s.id === scriptId)!;
  const progressPct = Math.min(100, (seconds / MAX_SEC) * 100);
  const minPct = (MIN_SEC / MAX_SEC) * 100;

  // Step 1 — record
  if (!take) return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-1.5">
        {SCRIPTS.map((s) => (
          <button key={s.id} onClick={() => setScriptId(s.id)}
            className={cn("rounded-md px-2.5 py-1 text-[11.5px] font-medium transition",
              scriptId === s.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground")}>
            {s.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-faint">or just talk naturally</span>
      </div>
      <p className="rounded-lg bg-surface p-3 text-[13px] leading-relaxed text-foreground">{script.text}</p>
      <div className="flex items-center gap-3">
        <button onClick={recording ? stop : start}
          className={cn("flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12.5px] font-medium transition",
            recording ? "bg-danger text-white" : "bg-accent text-accent-foreground hover:opacity-90")}>
          {recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          {recording ? "Stop" : "Start recording"}
        </button>
        {recording ? (
          <div className="flex flex-1 items-center gap-2.5">
            {/* elapsed bar with the minimum-length marker */}
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
              <div className={cn("h-full rounded-full transition-[width] duration-200", seconds >= MIN_SEC ? "bg-success" : "bg-arc")} style={{ width: `${progressPct}%` }} />
              <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${minPct}%` }} title={`${MIN_SEC}s minimum`} />
            </div>
            <span className="w-16 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">{seconds.toFixed(0)}s / {MAX_SEC}s</span>
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10" title="Input level">
              <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </div>
        ) : (
          <span className="text-[11.5px] text-faint">{MIN_SEC}–{MAX_SEC} seconds · quiet room, normal speaking distance</span>
        )}
      </div>
    </div>
  );

  // Step 2 — listen back + details + save
  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5">
        <button onClick={togglePlayback}
          className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition hover:opacity-90">
          {playing ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? "Stop" : "Listen back"}
        </button>
        <span className="text-[12px] text-muted-foreground">{(take.samples.length / take.sampleRate).toFixed(0)}s recorded</span>
        <button onClick={() => { stopPlayback.current?.(); setPlaying(false); setTake(null); setTranscript(""); }}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
          <RotateCcw className="size-3.5" /> Re-record
        </button>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] text-muted-foreground">{busy === "transcribe" ? "Transcribing…" : "Transcript — fix anything Whisper misheard; cloning quality depends on it."}</span>
        <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} placeholder="What you said, word for word"
          className="w-full resize-y rounded-lg bg-surface p-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-faint" />
      </label>
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="Voice name (e.g. Me)"
          className="h-9 flex-1 rounded-lg bg-surface px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-faint" />
        <button onClick={save} disabled={!consent || !transcript.trim() || busy !== null}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-40">
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save voice
        </button>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-snug text-muted-foreground">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
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
  const fileInput = useRef<HTMLInputElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const cfg = loadPipelineConfig();
  const activeId = cfg.tts.engine === "clone" ? cfg.tts.voice : null;

  useEffect(() => () => stopRef.current?.(), []);

  const useVoice = (id: string) => {
    savePipelineConfig({ ...cfg, tts: { ...cfg.tts, engine: "clone", voice: id } });
    onChange();
    toast("Cloned voice active — it speaks from your next call.");
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
      stopRef.current?.();
      stopRef.current = playPcm(samples, Number(res.headers.get("x-sample-rate")) || 24000);
    } catch (e) { toast(`Preview failed: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
  };

  const listen = async (p: VoiceProfile) => {
    setBusy(`listen:${p.id}`);
    try {
      const res = await fetch(`/api/voice/profiles/${p.id}/audio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      stopRef.current?.();
      stopRef.current = () => { a.pause(); URL.revokeObjectURL(url); };
      a.onended = () => URL.revokeObjectURL(url);
      void a.play();
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

  const remove = async (p: VoiceProfile) => {
    if (p.id === activeId) savePipelineConfig({ ...cfg, tts: { ...cfg.tts, engine: "kokoro", voice: "af_heart" } });
    await fetch(`/api/voice/profiles/${p.id}`, { method: "DELETE" }).catch(() => {});
    onChange();
  };

  return (
    <div className="flex max-w-xl flex-col gap-3">
      {profiles.length > 0 && (
        <input value={previewText} onChange={(e) => setPreviewText(e.target.value.slice(0, 200))}
          placeholder={`Preview text — try anything (default: “${DEFAULT_PREVIEW}”)`}
          className="h-9 w-full rounded-lg bg-card px-3 text-[12.5px] text-foreground shadow-[var(--shadow-card)] outline-none placeholder:text-faint" />
      )}

      {profiles.length === 0 && <p className="text-[12px] text-faint">No voices yet — record one above, or import a profile.</p>}

      {profiles.map((p) => (
        <div key={p.id} className={cn("flex flex-col gap-2 rounded-xl bg-card p-3 shadow-[var(--shadow-card)] transition", p.id === activeId && "shadow-[inset_0_0_0_1.5px_var(--accent)]")}>
          <div className="flex items-center gap-2">
            {renaming === p.id ? (
              <input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value.slice(0, 60))}
                onBlur={() => void rename(p)} onKeyDown={(e) => { if (e.key === "Enter") void rename(p); if (e.key === "Escape") setRenaming(null); }}
                className="h-7 flex-1 rounded-md bg-surface px-2 text-[13px] font-medium text-foreground outline-none" />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                {p.name}
                {p.id === activeId && <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">Speaking voice</span>}
              </span>
            )}
            <span className="shrink-0 text-[11px] text-faint">{p.seconds ? `${p.seconds.toFixed(0)}s · ` : ""}{new Date(p.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={() => preview(p)} disabled={busy !== null}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12px] font-medium text-background transition hover:opacity-90 disabled:opacity-40">
              {busy === `preview:${p.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Preview
            </button>
            {p.id !== activeId && (
              <button onClick={() => useVoice(p.id)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-accent px-2.5 text-[12px] font-medium text-accent-foreground transition hover:opacity-90">
                <Volume2 className="size-3.5" /> Use this voice
              </button>
            )}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconAction title="Play the original recording" onClick={() => listen(p)} busy={busy === `listen:${p.id}`} icon={Volume2} />
            <IconAction title="Rename" onClick={() => { setRenaming(p.id); setRenameTo(p.name); }} icon={Pencil} />
            <IconAction title="Export to a file" onClick={() => exportProfile(p)} icon={Download} />
            <IconAction title="Delete" onClick={() => remove(p)} icon={Trash2} danger />
          </div>
        </div>
      ))}

      <div>
        <input ref={fileInput} type="file" accept="application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProfile(f); e.target.value = ""; }} />
        <button onClick={() => fileInput.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
          <Upload className="size-3.5" /> Import a voice file
        </button>
      </div>
    </div>
  );
}

function IconAction({ title, onClick, icon: Icon, busy, danger }: { title: string; onClick: () => void; icon: typeof Play; busy?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10", danger ? "hover:text-danger" : "hover:text-foreground")}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
    </button>
  );
}
