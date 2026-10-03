"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioWaveform, Cpu, Languages, MessageSquareText, TextCursorInput } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { api } from "@/lib/api";
import { CURATED_LANGUAGES, familyInfo, loadPipelineConfig, onPipelineConfig, type PipelineConfig } from "@/lib/live/pipelineConfig";
import { ListGroup } from "@/components/ui";
import { LinkRow, useSettingsNav } from "./nav";
import { Section } from "./Section";

// The settings a mode follows but does not own, as rows that go to where they
// are set: one section, the same in Chat, Flow and Dictate. A mode that types
// shows how text goes in; a mode that talks back shows the voice and narration.

/** The shared voice in words: its name and speed. */
function voiceLine(c: PipelineConfig): string {
  const family = familyInfo("tts", c.tts.family);
  const name = family?.id === "clone" ? "Your voice" : family?.voices?.find((v) => v.id === c.tts.voice)?.name ?? (c.tts.voice || "Default");
  return `${name} · ${c.tts.speed.toFixed(2)}×`;
}

export function SharedSettings({ id, insertion, speaks }: { id: string; insertion?: FlowConfig["insertion"]; speaks: boolean }) {
  const go = useSettingsNav();
  const [pipeline, setPipeline] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setPipeline), []);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: speaks });
  const language = CURATED_LANGUAGES.find((l) => l.code === pipeline.language)?.name ?? pipeline.language;
  const stt = familyInfo("stt", pipeline.stt.family)?.name ?? pipeline.stt.family;
  const tts = familyInfo("tts", pipeline.tts.family)?.name ?? pipeline.tts.family;

  return (
    <Section id={id} title="Shared settings" desc="Set once, used everywhere.">
      <ListGroup>
        {insertion && (
          <LinkRow icon={TextCursorInput} label="Typing at cursor" shared={false} onGo={() => go("general", "set-general-typing")}
            value={`${insertion.method === "paste" ? "Paste" : "Type it out"}${insertion.method === "paste" && insertion.restoreClipboard ? ", clipboard put back" : ""}`} />
        )}
        <LinkRow icon={Languages} label="Language" value={language} onGo={() => go("voice", "set-voice-language")} />
        {speaks && <LinkRow icon={AudioWaveform} label="Voice" detail="Who speaks, and how fast" value={voiceLine(pipeline)} onGo={() => go("voice", "set-voice-voice")} />}
        {speaks && (
          <LinkRow icon={MessageSquareText} label="Narrate agent progress" detail="While a coding agent works" onGo={() => go("voice", "set-voice-narrate")}
            value={settings?.narrateProgress === "0" ? "Off" : "On"} />
        )}
        <LinkRow icon={Cpu} label="Speech engine" detail={speaks ? "Speech to text, and the voice" : "Speech to text"}
          value={speaks ? `${stt} · ${tts}` : stt} onGo={() => go("engine")} />
      </ListGroup>
    </Section>
  );
}
