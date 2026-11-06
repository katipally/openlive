"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FlowConfig } from "@openlive/flow-store";
import { ListGroup, ListRow, Select } from "@/components/ui";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { surfaceVoice, type Surface } from "@/lib/flow/voice";
import { engineName, languageLabel, voiceMenu } from "@/lib/live/engineMenu";
import { familyInfo, loadPipelineConfig, onPipelineConfig, savePipelineConfig, withSurfaceVoice, type PipelineConfig } from "@/lib/live/pipelineConfig";
import { Section } from "./Section";
import { LinkRow, useSettingsNav } from "./nav";
import { StatusDot } from "./common";
import { SttStage, TtsStage, useNativeEngines, variantStatus } from "./PipelineSettings";

// What Flow and Dictate hear with, and what Flow speaks with: Chat's engines,
// or the surface's own. The pickers are the Speech engine tab's own, drawn over
// the engines this surface would run on; the owner renderer applies the same
// picks (lib/flow/voice.ts) to every read of the pipeline.

const NAME: Record<Surface, string> = { flow: "Flow", dictate: "Dictate" };

type Save = (patch: FlowConfigPatch) => void;
type SpeechIn = FlowConfig["voice"]["stt"];
type SpeechOut = FlowConfig["voice"]["tts"];

/** "Same as Chat" or "Its own", and below it either where Chat's is set or the picker. */
function Choice({ label, id, name, own, follows, onChange, children }: {
  label: string; id: string; name: string; own: boolean; follows: ReactNode; onChange: (own: boolean) => void; children: ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-3">
      <ListGroup>
        <ListRow label={label} detail={own ? `Only in ${name}. Chat is unchanged.` : undefined}>
          <Select aria-label={`${label} in ${name}`} value={own ? "own" : "chat"} onChange={(e) => onChange(e.target.value === "own")}>
            <option value="chat">Same as Chat</option>
            <option value="own">Its own</option>
          </Select>
        </ListRow>
        {!own && follows}
      </ListGroup>
      {own && children}
    </div>
  );
}

/** The voices of the engine in use: its own list, the agent's for a native one, or the cloned voices. */
function VoiceSelect({ cfg, onPick }: { cfg: PipelineConfig; onPick: (voice: string) => void }) {
  const { data: engines } = useNativeEngines();
  const clone = cfg.tts.family === "clone";
  const { data: profiles = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["voice-profiles"], enabled: clone, queryFn: async () => {
      const r = await fetch("/api/voice/profiles");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const rows = clone ? profiles.map((p) => ({ id: p.id, name: p.name }))
    : familyInfo("tts", cfg.tts.family)?.voices?.map((v) => ({ id: v.id, name: `${v.name} · ${v.accent}` }))
      ?? [{ id: "", name: "Default for the language" },
        ...voiceMenu(variantStatus(engines, cfg.tts.variant)?.voices ?? [], cfg.language).map((v) => ({ id: v.id, name: [v.name, v.group].join(" · ") }))];
  if (cfg.tts.voice && !rows.some((r) => r.id === cfg.tts.voice)) rows.unshift({ id: cfg.tts.voice, name: cfg.tts.voice });
  if (clone && !rows.length) return <p className="text-caption text-faint">No cloned voices yet. Record one in Voice, under Your voices.</p>;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-foreground">Voice</span>
      <Select value={cfg.tts.voice} onChange={(e) => onPick(e.target.value)} className="w-full max-w-md">
        {rows.map((r) => <option key={r.id || "default"} value={r.id}>{r.name}</option>)}
      </Select>
    </label>
  );
}

export function SurfaceSpeech({ id, surface, config, save }: { id: string; surface: Surface; config: FlowConfig; save: Save }) {
  const go = useSettingsNav();
  const { data: engines } = useNativeEngines();
  const [shared, setShared] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setShared), []);

  const name = NAME[surface];
  const flow = surface === "flow";
  const stt = flow ? config.voice.stt : config.dictate.stt;
  const tts = config.voice.tts;
  const picks = surfaceVoice(config, surface);
  const shown = withSurfaceVoice(shared, picks);
  const saveStt = (next: SpeechIn) => save(flow ? { voice: { stt: next } } : { dictate: { stt: next } });
  const saveTts = (next: SpeechOut) => save({ voice: { tts: next } });
  // A restricted license allowed from a picker here is allowed for every mode, as everywhere.
  const allowed = (next: PipelineConfig) => { if (next.allowRestricted !== shared.allowRestricted) savePipelineConfig({ ...shared, allowRestricted: next.allowRestricted }); };

  const sttLine = (c: PipelineConfig) => (c.stt.variant === "whisper" ? `Whisper, ${c.stt.whisperSize}` : engineName(c.stt.variant, engines));
  // A saved pick that cannot run (another language was chosen since, or its license is no longer allowed) is not what runs, and the screen says so.
  const stale = (variant: string, running: string) => variant && variant !== running ? (
    <StatusDot tone="arc">{engineName(variant, engines)} doesn&apos;t fit {languageLabel(shared.language)} or the license settings, so {name} uses Chat&apos;s for now. Pick another below.</StatusDot>
  ) : null;

  return (
    <Section id={id} title={flow ? "Hearing and voice" : "Hearing"}
      desc={flow ? "What Flow hears with and speaks with. Chat's, or its own." : "What Dictate hears with. Chat's, or its own."}>
      <div className="flex flex-col gap-5">
        <Choice id={`${id}-stt`} label="Speech to text" name={name} own={stt.override}
          onChange={(override) => saveStt(override ? { override, variant: shared.stt.variant, whisperSize: shared.stt.whisperSize } : { ...stt, override })}
          follows={<LinkRow label="Chat's choice" value={sttLine(shared)} onGo={() => go("engine", "set-engine-stage-stt")} />}>
          {stale(stt.variant, shown.stt.variant)}
          <SttStage cfg={shown} scope={surface}
            update={(next) => { allowed(next); saveStt({ override: true, variant: next.stt.variant, whisperSize: next.stt.whisperSize }); }} />
        </Choice>
        {flow && (
          <Choice id={`${id}-tts`} label="Voice" name={name} own={tts.override}
            onChange={(override) => saveTts(override ? { override, variant: shared.tts.variant, voice: shared.tts.voice } : { ...tts, override })}
            follows={<LinkRow label="Chat's choice" value={engineName(shared.tts.variant, engines)} onGo={() => go("voice", "set-voice-voice")} />}>
            {stale(tts.variant, shown.tts.variant)}
            <TtsStage cfg={shown} scope="flow"
              update={(next) => { allowed(next); saveTts({ override: true, variant: next.tts.variant, voice: next.tts.voice }); }} />
            <VoiceSelect cfg={shown} onPick={(voice) => saveTts({ override: true, variant: shown.tts.variant, voice })} />
          </Choice>
        )}
      </div>
    </Section>
  );
}
