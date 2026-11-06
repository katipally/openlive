import { expect, it } from "vitest";
import { DEFAULT_FLOW_CONFIG, parseFlowConfig } from "@openlive/flow-store";
import { DEFAULT_PIPELINE_CONFIG, withSurfaceVoice, type PipelineConfig } from "../live/pipelineConfig";
import { surfaceVoice } from "./voice";

const own = parseFlowConfig({
  voice: { stt: { override: true, variant: "parakeet-0.6b-v2-int8", whisperSize: "" }, tts: { override: true, variant: "kitten-nano-int8", voice: "luna" } },
  dictate: { stt: { override: true, variant: "whisper", whisperSize: "small" } },
});

it("follows Chat until a surface turns its own on", () => {
  expect(surfaceVoice(DEFAULT_FLOW_CONFIG, "flow")).toEqual({});
  expect(surfaceVoice(DEFAULT_FLOW_CONFIG, "dictate")).toEqual({});
  expect(surfaceVoice(null, "flow")).toBeNull();
});

it("hands each surface only its own picks, and Dictate never a voice", () => {
  expect(surfaceVoice(own, "flow")).toEqual({ stt: { variant: "parakeet-0.6b-v2-int8", whisperSize: "" }, tts: { variant: "kitten-nano-int8", voice: "luna" } });
  expect(surfaceVoice(own, "dictate")).toEqual({ stt: { variant: "whisper", whisperSize: "small" } });
  const off = parseFlowConfig({ ...own, voice: { ...own.voice, tts: { ...own.voice.tts, override: false } } });
  expect(surfaceVoice(off, "flow")?.tts).toBeUndefined();
});

const chat: PipelineConfig = DEFAULT_PIPELINE_CONFIG;

it("puts a surface's engines over the shared config and leaves the rest as it was", () => {
  const flow = withSurfaceVoice(chat, surfaceVoice(own, "flow"));
  expect(flow.stt.variant).toBe("parakeet-0.6b-v2-int8");
  expect(flow.stt.family).toBe("parakeet");
  expect(flow.tts).toMatchObject({ family: "kitten", variant: "kitten-nano-int8", voice: "luna" });
  expect(flow.vad).toEqual(chat.vad);
  expect(flow.language).toBe(chat.language);
  const dictate = withSurfaceVoice(chat, surfaceVoice(own, "dictate"));
  expect(dictate.stt).toMatchObject({ family: "whisper", whisperSize: "small" });
  expect(dictate.tts).toEqual(chat.tts);
  expect(withSurfaceVoice(chat, null)).toBe(chat);
});

it("keeps the shared engine for a pick that cannot run here", () => {
  const spanish: PipelineConfig = { ...chat, language: "es" };
  expect(withSurfaceVoice(spanish, { stt: { variant: "parakeet-0.6b-v2-int8", whisperSize: "" } }).stt).toEqual(spanish.stt);
  expect(withSurfaceVoice(chat, { stt: { variant: "no-such-engine", whisperSize: "" } }).stt).toEqual(chat.stt);
  expect(withSurfaceVoice(chat, { stt: { variant: "kitten-nano-int8", whisperSize: "" } }).stt).toEqual(chat.stt);
  expect(withSurfaceVoice(chat, { tts: { variant: "pocket-int8", voice: "bria" } }).tts).toEqual(chat.tts);
});

it("lets a voice the engine lacks give way to its default, and a bad Whisper size to the shared one", () => {
  expect(withSurfaceVoice(chat, { tts: { variant: "kitten-nano-int8", voice: "af_heart" } }).tts.voice).toBe("bella");
  expect(withSurfaceVoice(chat, { stt: { variant: "whisper", whisperSize: "medium" } }).stt.whisperSize).toBe(chat.stt.whisperSize);
});
