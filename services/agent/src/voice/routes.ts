import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { extract } from "tar";
import unbzip2 from "unbzip2-stream";
import { listVoiceProfiles, createVoiceProfile, deleteVoiceProfile, renameVoiceProfile } from "@openlive/db";
import { modelInstalled, modelDiskBytes, synthesize, unloadEngine, VOICE_MODEL_DIR, VOICE_PROFILE_DIR } from "./engine.js";
import { NATIVE_ENGINES, NATIVE_FAMILIES, nativeEngine, onOrt, engineInstalled, engineDiskBytes, engineDir, downloadEngine, langCode, speakable, type EngineVoice, type NativeEngine } from "./native-models.js";
import { pcmBytes, pcmFromBytes, SAMPLE_RATE } from "./pcm.js";
import { benchState, rebench, speak, transcribe, unloadNative } from "./native.js";
import { accelStatus, currentDevice, providersFor, setOverride, type Override } from "./accel.js";
import { ortProbe, threadsFor, tier } from "./device.js";
import { log } from "../log.js";

// Voice Studio REST surface, mounted at /voice (behind the same shared-secret
// gate as everything else; the web app reaches it through a same-origin Next
// proxy). Model download/delete is user-managed; profiles are a wav + its
// transcript; /tts streams raw Float32 PCM for the renderer's AudioPlayer.

const MODEL_TAR = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2";
const VOCODER = "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx";
// Verified 2026-07-16 against the release assets. Shown to the user BEFORE
// downloading; the stream reports live progress against these.
const DOWNLOAD_BYTES = 163_320_194; // 109,162,785 (tar.bz2) + 54,157,409 (vocoder)

let downloading = false;

export const voiceRoutes = new Hono();

voiceRoutes.get("/model", (c) =>
  c.json({ installed: modelInstalled(), downloading, downloadBytes: DOWNLOAD_BYTES, diskBytes: modelDiskBytes() }));

// Streamed download: JSON-lines progress ({loaded,total} per chunk batch), the
// same consumption pattern as the agent-install stream. Files land as .part /
// into a temp dir and move into place only when complete.
voiceRoutes.post("/model/download", (c) => {
  if (downloading) return c.json({ error: "already downloading" }, 409);
  if (modelInstalled()) return c.json({ error: "already installed" }, 409);
  downloading = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let loaded = 0;
      let lastPush = 0;
      const progress = (n: number) => {
        loaded += n;
        if (Date.now() - lastPush > 200) { lastPush = Date.now(); try { controller.enqueue(enc.encode(JSON.stringify({ loaded, total: DOWNLOAD_BYTES }) + "\n")); } catch { /* client gone; keep downloading */ } }
      };
      const counted = () => new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctrl) { progress(chunk.byteLength); ctrl.enqueue(chunk); } });
      try {
        mkdirSync(VOICE_MODEL_DIR, { recursive: true });

        // 1) model tarball → extracted into the model dir (strip the top folder)
        const tarRes = await fetch(MODEL_TAR, { redirect: "follow" });
        if (!tarRes.ok || !tarRes.body) throw new Error(`model download HTTP ${tarRes.status}`);
        await pipeline(
          Readable.fromWeb(tarRes.body.pipeThrough(counted()) as never),
          unbzip2(),
          extract({ cwd: VOICE_MODEL_DIR, strip: 1 }),
        );

        // 2) vocoder → .part then atomic rename
        const vocRes = await fetch(VOCODER, { redirect: "follow" });
        if (!vocRes.ok || !vocRes.body) throw new Error(`vocoder download HTTP ${vocRes.status}`);
        const part = join(VOICE_MODEL_DIR, "vocos_24khz.onnx.part");
        await pipeline(Readable.fromWeb(vocRes.body.pipeThrough(counted()) as never), createWriteStream(part));
        renameSync(part, join(VOICE_MODEL_DIR, "vocos_24khz.onnx"));

        controller.enqueue(enc.encode(JSON.stringify({ loaded: DOWNLOAD_BYTES, total: DOWNLOAD_BYTES, done: true }) + "\n"));
      } catch (e) {
        log.error("voice", "model download:", e);
        rmSync(VOICE_MODEL_DIR, { recursive: true, force: true }); // no partial installs
        try { controller.enqueue(enc.encode(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n")); } catch { /* closed */ }
      } finally {
        downloading = false;
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
});

voiceRoutes.delete("/model", (c) => {
  unloadEngine();
  rmSync(VOICE_MODEL_DIR, { recursive: true, force: true });
  return c.json({ ok: true });
});

// ── profiles ─────────────────────────────────────────────────────────────────
/** Rough duration from a 16-bit mono WAV header (all our profile wavs). */
function wavSeconds(wav: Buffer): number | undefined {
  try {
    const rate = wav.readUInt32LE(24);
    return rate > 0 ? Math.round(((wav.length - 44) / 2 / rate) * 10) / 10 : undefined;
  } catch { return undefined; }
}

async function saveProfile(name: string, transcript: string, wav: Buffer) {
  mkdirSync(VOICE_PROFILE_DIR, { recursive: true });
  const wavFile = `${randomUUID()}.wav`;
  writeFileSync(join(VOICE_PROFILE_DIR, wavFile), wav, { mode: 0o600 });
  return createVoiceProfile({ name, transcript, wavFile, seconds: wavSeconds(wav) });
}

voiceRoutes.get("/profiles", (c) => c.json(listVoiceProfiles()));

voiceRoutes.post("/profiles", async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: string; transcript?: string; wavBase64?: string; consent?: boolean } | null;
  const name = body?.name?.trim().slice(0, 60);
  const transcript = body?.transcript?.trim().slice(0, 500);
  if (!body?.consent) return c.json({ error: "Consent is required — clone only your own voice or one you have permission for." }, 400);
  if (!name || !transcript || !body.wavBase64) return c.json({ error: "name, transcript, and recording are required" }, 400);
  const wav = Buffer.from(body.wavBase64, "base64");
  if (wav.length < 32_000 || wav.length > 30_000_000) return c.json({ error: "recording must be roughly 5–30 seconds of audio" }, 400);
  return c.json(await saveProfile(name, transcript, wav));
});

// Import a previously exported profile (same JSON the export produces). Consent
// is re-affirmed by the importer — it's the same person moving machines.
voiceRoutes.post("/profiles/import", async (c) => {
  const body = await c.req.json().catch(() => null) as { openliveVoiceProfile?: number; name?: string; transcript?: string; wavBase64?: string } | null;
  if (body?.openliveVoiceProfile !== 1 || !body.name || !body.transcript || !body.wavBase64) {
    return c.json({ error: "not an OpenLive voice profile file" }, 400);
  }
  const wav = Buffer.from(body.wavBase64, "base64");
  if (wav.length < 32_000 || wav.length > 30_000_000) return c.json({ error: "the profile's recording looks invalid" }, 400);
  return c.json(await saveProfile(body.name.trim().slice(0, 60), body.transcript.trim().slice(0, 500), wav));
});

voiceRoutes.patch("/profiles/:id", async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: string } | null;
  const name = body?.name?.trim().slice(0, 60);
  if (!name) return c.json({ error: "name required" }, 400);
  const row = await renameVoiceProfile(c.req.param("id"), name);
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});

voiceRoutes.delete("/profiles/:id", async (c) => {
  const removed = await deleteVoiceProfile(c.req.param("id"));
  if (removed?.wavFile) rmSync(join(VOICE_PROFILE_DIR, removed.wavFile), { force: true });
  return c.json({ ok: true });
});

// The reference recording itself — so the user can listen back to what a
// profile was cloned from.
voiceRoutes.get("/profiles/:id/audio", (c) => {
  const p = listVoiceProfiles().find((r) => r.id === c.req.param("id"));
  if (!p || !existsSync(join(VOICE_PROFILE_DIR, p.wavFile))) return c.json({ error: "not found" }, 404);
  return new Response(readFileSync(join(VOICE_PROFILE_DIR, p.wavFile)), { headers: { "Content-Type": "audio/wav" } });
});

// Export/import: one self-contained JSON (metadata + the wav, base64).
voiceRoutes.get("/profiles/:id/export", (c) => {
  const p = listVoiceProfiles().find((r) => r.id === c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  const wav = readFileSync(join(VOICE_PROFILE_DIR, p.wavFile));
  return c.json({ openliveVoiceProfile: 1, name: p.name, transcript: p.transcript, wavBase64: wav.toString("base64") });
});

// ── synthesis ────────────────────────────────────────────────────────────────
voiceRoutes.post("/tts", async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: string; profileId?: string; speed?: number; engine?: string; voice?: string; lang?: string } | null;
  if (body?.engine !== undefined) return nativeTts(body, c.req.raw.signal);
  const text = body?.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  if (!modelInstalled()) return c.json({ error: "model-not-installed" }, 409);
  const profile = listVoiceProfiles().find((p) => p.id === body?.profileId);
  if (!profile) return c.json({ error: "profile-missing" }, 404);
  const wavPath = join(VOICE_PROFILE_DIR, profile.wavFile);
  if (!existsSync(wavPath)) return c.json({ error: "profile-missing" }, 404);
  const speed = Math.min(2, Math.max(0.5, Number(body?.speed) || 1));
  try {
    const audio = await synthesize(text, { wavPath, transcript: profile.transcript }, speed);
    return new Response(Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength), {
      headers: { "Content-Type": "application/octet-stream", "x-sample-rate": String(audio.sampleRate) },
    });
  } catch (e) {
    log.error("voice", "tts:", e);
    return c.json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// ── native engines (see native-models.ts) ────────────────────────────────────
const STT_MAX_BYTES = 60 * SAMPLE_RATE * 4; // 60 s of mono Float32
const TTS_MAX_CHARS = 5_000;
const engineDownloads = new Map<string, AbortController>();
const notInstalled = (name: string) => ({ error: "engine-not-installed", message: `${name} is not downloaded yet` });
/** onnxruntime-node ships no binary for some platforms (Intel Macs as of 1.30.0). */
const runnable = (e: NativeEngine) => !onOrt(e) || !!ortProbe();
/** An engine asked for a language it does not speak refuses rather than
 *  transcribing or reading it wrong. */
const unsupported = (e: NativeEngine, lang: string) => ({ error: "language-not-supported", message: `${e.name} does not support "${lang}"` });

// O(variants + files on disk under the installed ones).
voiceRoutes.get("/engines", (c) => c.json(NATIVE_FAMILIES.map((f) => ({
  family: f.id, kind: f.kind, name: f.name, browser: f.browser,
  variants: f.variants.map((e) => ({
    id: e.id, legacyId: e.legacyId, name: e.name, sizeBytes: e.sizeBytes, quality: e.quality, languages: e.languages,
    streaming: !!e.streaming, latencyMs: e.latencyMs, license: e.license, runnable: runnable(e),
    installed: engineInstalled(e), downloading: engineDownloads.has(e.id), bytes: engineDiskBytes(e.id),
    voices: e.voices?.map(({ id, name, lang, gender }) => ({ id, name, lang, gender })),
  })),
}))));

// Same JSON-lines progress stream as /model/download. DELETE /engines/:id
// during a download cancels it.
voiceRoutes.post("/engines/:id/download", (c) => {
  const e = nativeEngine(c.req.param("id"));
  if (!e) return c.json({ error: "unknown engine" }, 400);
  if (engineDownloads.has(e.id)) return c.json({ error: "already downloading" }, 409);
  if (engineInstalled(e)) return c.json({ error: "already installed" }, 409);
  if (!runnable(e)) return c.json({ error: `${e.name} cannot run on this computer` }, 409);
  const abort = new AbortController();
  engineDownloads.set(e.id, abort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (o: object) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* client gone; keep downloading */ } };
      let loaded = 0;
      let lastPush = 0;
      try {
        await downloadEngine(e, (n) => {
          loaded += n;
          if (Date.now() - lastPush > 200) { lastPush = Date.now(); push({ loaded, total: e.sizeBytes }); }
        }, abort.signal);
        push({ loaded: e.sizeBytes, total: e.sizeBytes, done: true });
      } catch (err) {
        if (!abort.signal.aborted) log.error("voice", `${e.id} download:`, err);
        push({ error: abort.signal.aborted ? "cancelled" : String((err as Error)?.message ?? err) });
      } finally {
        engineDownloads.delete(e.id);
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
});

voiceRoutes.delete("/engines/:id", (c) => {
  const e = nativeEngine(c.req.param("id"));
  if (!e) return c.json({ error: "unknown engine" }, 400);
  engineDownloads.get(e.id)?.abort();
  unloadNative(e);
  rmSync(engineDir(e.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

// Where native speech runs on this device (accel.ts): the device profile, and
// per installed engine its provider, threads, the user's override and the
// benchmark behind the choice. O(installed engines x their files).
voiceRoutes.get("/perf", (c) => {
  const d = currentDevice();
  const { running, queued } = benchState();
  return c.json({
    device: { ...d, tier: tier(d), numThreads: threadsFor(d) },
    engines: Object.fromEntries(NATIVE_ENGINES.filter(engineInstalled).map((e) => {
      const s = accelStatus(e);
      const bench = running === e.id ? "running" : queued.includes(e.id) ? "queued" : s.providers.length < 2 ? "cpu-only" : s.measuredAt ? "done" : "pending";
      return [e.id, { ...s, bench }];
    })),
  });
});

// Body: { override: "auto" | a provider this device has }. The next load uses it.
voiceRoutes.put("/perf/engines/:id", async (c) => {
  const e = nativeEngine(c.req.param("id"));
  if (!e) return c.json({ error: "unknown engine" }, 400);
  const { override } = await c.req.json().catch(() => ({})) as { override?: string };
  if (override !== "auto" && !providersFor(e, currentDevice()).some((p) => p === override)) return c.json({ error: "unsupported provider" }, 400);
  setOverride(e, override as Override);
  unloadNative(e);
  return c.json(accelStatus(e));
});

voiceRoutes.post("/perf/engines/:id/bench", (c) => {
  const e = nativeEngine(c.req.param("id"));
  if (!e) return c.json({ error: "unknown engine" }, 400);
  if (!engineInstalled(e)) return c.json(notInstalled(e.name), 409);
  rebench(e);
  return c.json({ ok: true });
});

// Body: raw little-endian Float32 PCM, 16 kHz mono.
voiceRoutes.post("/stt", bodyLimit({ maxSize: STT_MAX_BYTES, onError: (c) => c.json({ error: "audio is longer than 60 s" }, 413) }), async (c) => {
  const e = nativeEngine(c.req.query("engine"));
  if (e?.kind !== "asr") return c.json({ error: "unknown speech-to-text engine" }, 400);
  const lang = langCode(c.req.query("lang")) ?? undefined;
  if (lang && !e.languages.includes(lang)) return c.json(unsupported(e, lang), 400);
  if (!engineInstalled(e)) return c.json(notInstalled(e.name), 409);
  const samples = pcmFromBytes(new Uint8Array(await c.req.arrayBuffer()));
  if (!samples) return c.json({ error: "body must be raw Float32 PCM" }, 400);
  if (!samples.length) return c.json({ text: "" });
  try {
    return c.json(await transcribe(e, samples, c.req.raw.signal, lang));
  } catch (err) {
    log.error("voice", "stt:", err);
    return c.json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});

/** Streams raw Float32 PCM chunks as they are generated; a client that hangs
 *  up cancels the rest of the synthesis, even one still queued behind another.
 *  A voice that does not speak `lang` gives way to the first one that does:
 *  kokoro's af_heart reading Spanish lost its first words (measured 2026-09-24). */
async function nativeTts(body: { engine?: string; text?: string; voice?: string; speed?: number; lang?: string }, signal: AbortSignal): Promise<Response> {
  const e = nativeEngine(body.engine);
  if (e?.kind !== "tts") return Response.json({ error: "unknown text-to-speech engine" }, { status: 400 });
  if (!body.text?.trim()) return Response.json({ error: "text required" }, { status: 400 });
  const text = speakable(body.text);
  if (text.length > TTS_MAX_CHARS) return Response.json({ error: `text is longer than ${TTS_MAX_CHARS} characters` }, { status: 413 });
  const lang = langCode(body.lang);
  if (lang && !e.languages.includes(lang)) return Response.json(unsupported(e, lang), { status: 400 });
  const named = e.voices?.find((v) => v.id === body.voice);
  if (body.voice !== undefined && !named) return Response.json({ error: "unknown voice" }, { status: 400 });
  // A voice without a language (a Supertonic style) speaks every one of the engine's.
  const speaks = (v: EngineVoice) => !lang || !v.lang || v.lang === lang;
  const voice = named && speaks(named) ? named : e.voices?.find(speaks);
  if (!voice) return Response.json({ error: "unknown voice" }, { status: 400 });
  if (!engineInstalled(e)) return Response.json(notInstalled(e.name), { status: 409 });
  if (!runnable(e)) return Response.json({ error: "engine-not-runnable", message: `${e.name} cannot run on this computer` }, { status: 409 });
  const speed = Math.min(2, Math.max(0.5, Number(body.speed) || 1));
  // Nothing left to say (a lone emoji): silence, not an error the client would
  // count against the engine.
  if (!text) return new Response(new Uint8Array(0), { headers: { "Content-Type": "application/octet-stream" } });

  let out!: ReadableStreamDefaultController<Uint8Array>;
  const audio = new ReadableStream<Uint8Array>({ start: (ctrl) => { out = ctrl; }, cancel: () => job.cancel() });
  const job = speak(e, text, voice, speed, (s) => { try { out.enqueue(pcmBytes(s)); } catch { /* client gone */ } }, lang ?? undefined);
  if (signal.aborted) job.cancel();
  else signal.addEventListener("abort", job.cancel, { once: true });
  job.done.then(() => { try { out.close(); } catch { /* closed */ } }, (err) => {
    log.error("voice", "tts:", err);
    try { out.error(err); } catch { /* closed */ }
  });
  try {
    const sampleRate = await job.started;
    return new Response(audio, { headers: { "Content-Type": "application/octet-stream", "x-sample-rate": String(sampleRate) } });
  } catch (err) {
    return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}
