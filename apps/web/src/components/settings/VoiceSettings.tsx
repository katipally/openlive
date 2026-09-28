"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Layers, Loader2, Play } from "lucide-react";
import {
  loadPipelineConfig, savePipelineConfig, onPipelineConfig, familyInfo, isNativeVariant, activeTurnPreset, withWait,
  TTS_FAMILIES, TURN_PRESETS, type PipelineConfig,
} from "@/lib/live/pipelineConfig";
import { voiceMenu } from "@/lib/live/engineMenu";
import { usePendingDeletes } from "@/lib/deferredDelete";
import { useMotionTokens } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { cn } from "@/lib/cn";
import { Segmented, Slider, Switch, Button, linkClass, Tooltip, ListGroup, ListRow } from "@/components/ui";
import { LanguagePicker, Experimental, SAMPLE, playPreview, useNativeEngines, variantStatus } from "./PipelineSettings";
import { VoicesSettings } from "./VoicesSettings";
import { PronunciationSettings } from "./PronunciationSettings";
import { Section } from "./Section";
import { useSettingsNav } from "./nav";

// How OpenLive hears and speaks, set once for Chat and Flow: the language first
// (every stage follows it), then who speaks and how fast, then how long it
// waits, then how words are said, then cloned voices. The engines behind all of
// this live in Speech engine.

/** The pipeline config, kept in step with every other editor of it on the page. */
function usePipeline(): [PipelineConfig, (c: PipelineConfig) => void] {
  const [cfg, setCfg] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setCfg), []);
  return [cfg, (c) => setCfg(savePipelineConfig(c))];
}

interface VoiceRow { id: string; name: string; detail?: string }

/** The voices of the engine in use, each with a sample to hear. A long list
 *  scrolls inside its card, with the chosen voice brought into view. */
function VoicePicker() {
  const [cfg, save] = usePipeline();
  const { reduce } = useMotionTokens();
  const go = useSettingsNav();
  const { data: engines } = useNativeEngines();
  const [busy, setBusy] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const clone = cfg.tts.family === "clone";
  const { data: allProfiles = [], isLoading } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["voice-profiles"], enabled: clone, queryFn: async () => {
      const r = await fetch("/api/voice/profiles");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const pending = usePendingDeletes((s) => s.keys);
  const engine = familyInfo("tts", cfg.tts.family) ?? TTS_FAMILIES[0]!;
  const native = isNativeVariant(cfg.tts.variant);
  const status = variantStatus(engines, cfg.tts.variant);
  const unplayable = native && !status?.installed;

  // A native engine without a static list names its voices in the agent's
  // catalog, cut to the session language; "" lets the agent pick one.
  const rows: VoiceRow[] = clone
    ? allProfiles.filter((p) => !pending.has(`voice:${p.id}`)).map((p) => ({ id: p.id, name: p.name, detail: "Your recording" }))
    : engine.voices?.map((v) => ({ id: v.id, name: v.name, detail: `${v.accent} · ${v.gender}` }))
      ?? [{ id: "", name: "Default for the language", detail: "The engine picks one that speaks it" },
        ...voiceMenu(status?.voices ?? [], cfg.language).map((v) => ({ id: v.id, name: v.name, detail: [v.group, v.gender].filter(Boolean).join(" · ") }))];
  if (!clone && cfg.tts.voice && !rows.some((r) => r.id === cfg.tts.voice)) rows.unshift({ id: cfg.tts.voice, name: cfg.tts.voice });

  // Scroll the list, not the page, to the chosen voice.
  useLayoutEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>("[aria-checked=true]")?.parentElement;
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
  }, [cfg.tts.family, rows.length]);

  const hear = async (id: string) => {
    setBusy(id);
    try { await playPreview(SAMPLE, { ...cfg, tts: { ...cfg.tts, voice: id } }); }
    catch (e) { log.error("tts", "voice preview:", e); toast("Voice preview failed. Download the engine in Speech engine, then try again."); }
    finally { setBusy(null); }
  };
  const openYours = () => document.getElementById("set-voice-yours")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });

  return (
    <Section id="set-voice-voice" title="Voice" desc={`The voice that answers. From the ${engine.name} engine.`}>
      <div className="overflow-hidden rounded-lg bg-card shadow-card">
        {clone && !isLoading && rows.length === 0 ? (
          <div className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 px-card-x py-2 text-body text-muted-foreground">
            No cloned voices yet.
            <button type="button" onClick={openYours} className={linkClass}>Record one under Your voices</button>
          </div>
        ) : (
          <div ref={list} role="radiogroup" aria-label="Voice" className="openlive-scroll relative max-h-[min(22rem,55vh)] divide-y divide-border overflow-y-auto px-card-x">
            {rows.map((r) => {
              const on = r.id === cfg.tts.voice;
              return (
                <div key={r.id || "default"} className="flex min-h-row items-center gap-3 py-1.5">
                  <Tooltip label={unplayable ? "Download this engine first, in Speech engine" : "Play a sample (downloads the voice first if needed)"}>
                    <Button variant="secondary" size="sm" icon aria-label={`Hear ${r.name}`} aria-disabled={busy !== null || unplayable || undefined}
                      onClick={() => { if (busy === null && !unplayable) void hear(r.id); }}>
                      {busy === r.id ? <Loader2 className="animate-spin" /> : <Play />}
                    </Button>
                  </Tooltip>
                  <button type="button" role="radio" aria-checked={on} onClick={() => save({ ...cfg, tts: { ...cfg.tts, voice: r.id } })}
                    className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("break-words text-body text-foreground", on && "font-medium")}>{r.name}</span>
                      {r.detail && <span className="break-words text-label text-muted-foreground">{r.detail}</span>}
                    </span>
                    {on && <Check aria-hidden className="size-4 shrink-0 text-link-foreground" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <button type="button" onClick={() => go("engine", "set-engine-stage-tts")}
          className="flex min-h-row w-full items-center gap-2.5 border-t border-border px-card-x py-2 text-left text-label text-link-foreground transition hover:text-foreground">
          <Layers aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">More voices come with other engines in Speech engine</span>
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        </button>
      </div>
    </Section>
  );
}

/** Speaking speed for every voice; applies from the next reply. */
function SpeakingSpeed() {
  const [cfg, save] = usePipeline();
  return (
    <Slider label="Speaking speed" value={cfg.tts.speed} min={0.5} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`}
      onChange={(speed) => save({ ...cfg, tts: { ...cfg.tts, speed } })} />
  );
}

/** Turn-taking in plain words. One wait for Chat and Flow; Flow may keep its own. */
function Conversation() {
  const [cfg, save] = usePipeline();
  const go = useSettingsNav();
  const preset = activeTurnPreset(cfg);
  return (
    <Section id="set-voice-conversation" title="Conversation" desc="Turn-taking in plain words. The engine details live in Speech engine.">
      <ListGroup>
        <ListRow label="Wait before answering" detail="How long it waits before deciding you have finished. Flow can keep its own." className="py-3">
          <div id="set-voice-wait" className="flex basis-full flex-col gap-2">
            <Segmented label="Wait before answering" className="grid w-full" value={preset === "custom" ? null : preset}
              options={TURN_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: p.desc, title: p.desc }))}
              onChange={(id) => save(withWait(cfg, TURN_PRESETS.find((p) => p.id === id)!.values))} />
            {preset === "custom" && (
              <p className="text-caption text-faint">
                Custom: tuned by hand in{" "}
                <button type="button" onClick={() => go("engine", "set-engine-stage-turn")} className={linkClass}>Speech engine, Turn-taking</button>.
              </p>
            )}
          </div>
        </ListRow>
        <ListRow asLabel label={<span id="set-voice-listening-sounds" className="flex flex-wrap items-center gap-x-2 gap-y-1">Listening sounds <Experimental /></span>}
          detail="A quiet “mm-hmm” in the reply's voice at a pause while you talk at length. Never after a question or over your voice, and never in the transcript. Calls only, not Flow.">
          <Switch on={cfg.turn.backchannels} onFlip={() => save({ ...cfg, turn: { ...cfg.turn, backchannels: !cfg.turn.backchannels } })} />
        </ListRow>
      </ListGroup>
    </Section>
  );
}

export function VoiceSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-voice-language" title="Language" desc="What you speak and what OpenLive answers in. Transcription, the voice and the reply all follow it.">
        <LanguagePicker />
      </Section>
      <VoicePicker />
      <Section id="set-voice-speaking" title="Speaking" desc="How fast replies are read out, whichever voice is speaking.">
        <SpeakingSpeed />
      </Section>
      <Conversation />
      <PronunciationSettings />
      <div id="set-voice-yours">
        <VoicesSettings />
      </div>
    </div>
  );
}
