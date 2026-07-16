"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, Mic, Play, Square, Trash2, Upload } from "lucide-react";
import { stt, modelsReady, loadModels } from "@/lib/live/models";
import { loadPipelineConfig, savePipelineConfig } from "@/lib/live/pipelineConfig";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { cn } from "@/lib/cn";

// Voice Studio: clone a voice from a 5–30s recording and speak with it.
// Synthesis runs in the local agent service (ZipVoice, Apache-2.0, via
// sherpa-onnx) — the model is an optional, deletable ~208 MB install and the
// recording never leaves this machine.

export interface VoiceProfile { id: string; name: string; transcript: string; createdAt: string }
interface ModelState { installed: boolean; downloading: boolean; downloadBytes: number; diskBytes: number }

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

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

export function VoiceStudio() {
  const qc = useQueryClient();
  const { data: model } = useQuery<ModelState>({ queryKey: ["voice-model"], queryFn: () => fetch("/api/voice/model").then((r) => r.json()) });
  const { data: profiles = [] } = useQuery<VoiceProfile[]>({ queryKey: ["voice-profiles"], queryFn: () => fetch("/api/voice/profiles").then((r) => r.json()) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["voice-model"] }); void qc.invalidateQueries({ queryKey: ["voice-profiles"] }); };

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-3.5 shadow-[var(--shadow-card)]">
      <div>
        <p className="text-[13px] font-semibold text-foreground">Voice Studio</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Clone a voice from a short recording — everything runs on this machine (ZipVoice, Apache-2.0).
          English and Chinese. Only clone your own voice, or one you have clear permission to use.
        </p>
      </div>
      <ModelCard model={model} onChange={refresh} />
      {model?.installed && <Recorder onSaved={refresh} />}
      {model?.installed && profiles.length > 0 && <ProfileList profiles={profiles} onChange={refresh} />}
    </div>
  );
}

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
          try {
            const m = JSON.parse(line) as { loaded?: number; total?: number; error?: string };
            if (m.error) throw new Error(m.error);
            if (m.loaded && m.total) setProgress(m.loaded / m.total);
          } catch (e) { if ((e as Error).message !== "Unexpected end of JSON input") throw e; }
        }
      }
    } catch (e) {
      log.error("voice", "model download:", e);
      toast(`Voice model download failed: ${String((e as Error)?.message ?? e)}`);
    } finally { setProgress(null); onChange(); }
  };

  const remove = async () => {
    await fetch("/api/voice/model", { method: "DELETE" }).catch(() => {});
    onChange();
    toast("Cloning model removed — its disk space is freed.");
  };

  if (!model) return <p className="text-[12px] text-muted-foreground">Checking…</p>;
  if (progress !== null || model.downloading) return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
      </div>
      <p className="text-[11.5px] text-faint">Downloading the cloning model… {Math.round((progress ?? 0) * 100)}%</p>
    </div>
  );
  return model.installed ? (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-[12px] text-success"><Check className="size-3.5" /> Cloning model installed ({mb(model.diskBytes)})</span>
      <button onClick={remove} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
        <Trash2 className="size-3.5" /> Remove
      </button>
    </div>
  ) : (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-muted-foreground">One-time download, deletable anytime ({mb(model.downloadBytes)}).</span>
      <button onClick={download} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-foreground transition hover:opacity-90">
        <Download className="size-3.5" /> Download
      </button>
    </div>
  );
}

const MIN_SEC = 5, MAX_SEC = 30;
const SCRIPT = "Read naturally: The quick brown fox jumps over the lazy dog. I'm recording a short sample so my computer can speak in my voice — everything stays on this machine.";

function Recorder({ onSaved }: { onSaved: () => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [take, setTake] = useState<{ samples: Float32Array; sampleRate: number } | null>(null);
  const [transcript, setTranscript] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"transcribe" | "save" | null>(null);
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; raf: number } | null>(null);

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
        // Whisper expects 16 kHz — cheap linear resample.
        const ratio = sampleRate / 16000;
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
      toast("Voice saved — pick it as your TTS voice above.");
      onSaved();
    } catch (e) { toast(`Couldn't save the voice: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-3">
      {!take ? (
        <div className="flex items-center gap-3">
          <button onClick={recording ? stop : start}
            className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition",
              recording ? "bg-danger text-white" : "bg-foreground text-background hover:opacity-90")}>
            {recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
            {recording ? `Stop (${seconds.toFixed(0)}s)` : "Record a sample"}
          </button>
          {recording && (
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-foreground/10">
              <div className="h-full rounded-full bg-success transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          )}
          {!recording && <span className="text-[11px] leading-snug text-faint">{MIN_SEC}–{MAX_SEC} seconds. Suggested: “{SCRIPT}”</span>}
        </div>
      ) : (
        <>
          <p className="text-[11.5px] text-muted-foreground">
            {(take.samples.length / take.sampleRate).toFixed(0)}s recorded.
            {busy === "transcribe" ? " Transcribing…" : " Check the transcript matches what you said — cloning quality depends on it."}
          </p>
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} placeholder="What you said, word for word"
            className="w-full resize-y rounded-lg bg-surface p-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-faint" />
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="Voice name (e.g. Me)"
              className="h-8 flex-1 rounded-lg bg-surface px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-faint" />
            <button onClick={() => setTake(null)} className="h-8 rounded-lg border border-border px-2.5 text-[12px] text-muted-foreground transition hover:text-foreground">Discard</button>
            <button onClick={save} disabled={!consent || !transcript.trim() || busy !== null}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-40">
              {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Save voice
            </button>
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-snug text-muted-foreground">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            This is my own voice, or I have this person&apos;s permission. Cloned speech is generated on this device only.
          </label>
        </>
      )}
    </div>
  );
}

function ProfileList({ profiles, onChange }: { profiles: VoiceProfile[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const cfg = loadPipelineConfig();
  const activeId = cfg.tts.engine === "clone" ? cfg.tts.voice : null;

  const useVoice = (id: string) => {
    savePipelineConfig({ ...cfg, tts: { ...cfg.tts, engine: "clone", voice: id } });
    onChange();
    toast("Cloned voice active — it speaks from your next reply.");
  };

  const preview = async (p: VoiceProfile) => {
    setBusy(p.id);
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi! This is how I sound as your assistant.", profileId: p.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const samples = new Float32Array(buf);
      const rate = Number(res.headers.get("x-sample-rate")) || 24000;
      const ctx = new AudioContext();
      const audio = ctx.createBuffer(1, samples.length, rate);
      audio.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = audio; src.connect(ctx.destination); src.start();
      src.onended = () => { void ctx.close(); };
    } catch (e) { toast(`Preview failed: ${String((e as Error)?.message ?? e)}`); }
    finally { setBusy(null); }
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

  const remove = async (p: VoiceProfile) => {
    await fetch(`/api/voice/profiles/${p.id}`, { method: "DELETE" }).catch(() => {});
    onChange();
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      {profiles.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-foreground">{p.name}{p.id === activeId && <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">Active</span>}</span>
          <button onClick={() => preview(p)} disabled={busy === p.id} title="Preview" aria-label={`Preview ${p.name}`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground disabled:opacity-40">
            {busy === p.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          </button>
          {p.id !== activeId && (
            <button onClick={() => useVoice(p.id)} className="rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">Use</button>
          )}
          <button onClick={() => exportProfile(p)} title="Export" aria-label={`Export ${p.name}`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Download className="size-3.5" /></button>
          <button onClick={() => remove(p)} title="Delete" aria-label={`Delete ${p.name}`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-danger"><Trash2 className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

// ponytail: profile EXPORT ships now; import lands when someone asks for it
// (the exported JSON already carries everything needed).
