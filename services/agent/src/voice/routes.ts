import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { extract } from "tar";
import unbzip2 from "unbzip2-stream";
import { listVoiceProfiles, createVoiceProfile, deleteVoiceProfile, renameVoiceProfile } from "@openlive/db";
import { modelInstalled, modelDiskBytes, synthesize, unloadEngine, VOICE_MODEL_DIR, VOICE_PROFILE_DIR } from "./engine.js";
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
  const body = await c.req.json().catch(() => null) as { text?: string; profileId?: string; speed?: number } | null;
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
