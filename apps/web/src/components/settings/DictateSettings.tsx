"use client";

import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import type { DictateTone, FlowConfig } from "@openlive/flow-store";
import { Keycaps, ListGroup, ListRow, Segmented, Select, Switch } from "@/components/ui";
import { desktopPlatform } from "@/lib/platform";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { cleanup, type CleanupRules } from "@/lib/dictate/cleanup";
import { POLISH_MS } from "@/lib/dictate/run";
import { hotkeyKeys, keyName, liveKeys } from "@/lib/dictate/hotkey";
import { CURATED_LANGUAGES, loadPipelineConfig, onPipelineConfig } from "@/lib/live/pipelineConfig";
import { dictateBrain, flowBrain } from "@openlive/flow-store/shared";
import { AddonCard } from "@/components/flow/AddonCard";
import { TalkLinks } from "@/components/flow/FlowSettings";
import { Section } from "./Section";
import { LinkRow, useSettingsNav } from "./nav";
import { ModeOnLine, QueryState, StatusDot } from "./common";
import { DictateWords } from "./DictateWords";
import { DictateHistory } from "./DictateHistory";
import { SharedSettings } from "./SharedSettings";
import { AnswerSummary, useDefaultBrain, WhoAnswers } from "./WhoAnswers";

// The Dictate tab configures; Dictate's home is where it is switched on and
// used, and where its history is. Three subtabs. Basics, in the skeleton every
// mode's tab shares: how it opens, who answers AI polish and edits by voice,
// the shared settings, how it cleans up what was said, AI polish, and how long
// history is kept. Words: the dictionary and snippets. Commands: edit
// by voice and the spoken commands. Its key, how you talk, typing, voice and the
// speech engine are shared with Flow and Chat, so they are rows that go there.

type Pane = "basics" | "words" | "commands";
const TONES: { id: DictateTone; label: string }[] = [{ id: "natural", label: "Natural" }, { id: "casual", label: "Casual" }, { id: "formal", label: "Formal" }];
const SPOKEN: { id: keyof FlowConfig["dictate"]["commands"]; label: string; detail: string; info?: string }[] = [
  { id: "enter", label: "“Press enter”", detail: "Presses Return" },
  { id: "newLine", label: "“New line”", detail: "Line break, no send", info: "Shift+Return, which breaks the line in chat boxes without sending. In a terminal it runs the line." },
  { id: "newParagraph", label: "“New paragraph”", detail: "Two line breaks" },
  { id: "undo", label: "“Undo that”", detail: "Removes the last insert",
    info: "Said on its own. One Backspace per character Dictate typed last, so it only works while the cursor is still at the end of it. It never presses Ctrl+Z, which suspends a program in a terminal." },
  { id: "stop", label: "“Stop dictating”", detail: "Closes Dictate" },
];
const EXAMPLE = "um so send twenty five copies to uh Priya, actually Maya, by friday";

const RULES: { id: keyof CleanupRules; label: string; detail: string; info: string }[] = [
  { id: "punctuation", label: "Punctuation", detail: "Periods and capitals", info: "Capitals at the start of sentences, on I, days and months, and a period where the speech engine left none." },
  { id: "fillers", label: "Remove fillers", detail: "Drops um, uh, er", info: "Also drops “you know” and “like” when they are set off by pauses, never when they are part of the sentence." },
  { id: "backtrack", label: "Backtrack", detail: "“Actually” fixes the last bit", info: "“Scratch that” takes back the sentence. “Actually” or “no wait” swaps the last few words, only when the fix is short." },
  { id: "lists", label: "Lists", detail: "“One, two” becomes a list", info: "Items counted out loud from one, each after a pause, become numbered lines." },
  { id: "numbers", label: "Numbers", detail: "“Twenty five” becomes 25", info: "From ten up. One to nine stay words, as they read best." },
];

export function DictateSettings() {
  const { config, save, error, loading, refetch } = useFlowConfig();
  const [pane, setPane] = useState<Pane>("basics");

  if (!config) return <QueryState loading={loading} error={error || null} retrying={false} onRetry={refetch} what="read Dictate's settings" />;

  const own = config.dictate;
  const saveOwn = (patch: Partial<FlowConfig["dictate"]>) => save({ dictate: patch });
  return (
    <div className="flex flex-col gap-5">
      <ModeOnLine id="set-dictate-status" mode="dictate" on={own.enabled} />
      <Segmented label="Dictate" anchor="set-dictate" value={pane} onChange={setPane} className="w-full"
        options={[
          { id: "basics", label: "Basics" },
          { id: "words", label: "Words", count: own.words.length },
          { id: "commands", label: "Commands" },
        ]} />
      {error && <p className="text-label text-destructive-text">{error}</p>}
      {pane === "basics" && <Basics config={config} save={save} />}
      {pane === "words" && <DictateWords own={own} save={saveOwn} />}
      {pane === "commands" && <Commands config={config} save={save} />}
    </div>
  );
}

type Save = ReturnType<typeof useFlowConfig>["save"];

function Basics({ config, save }: { config: FlowConfig; save: Save }) {
  const go = useSettingsNav();
  const { caps, refresh } = useFlowCapabilities();
  const [pipeline, setPipeline] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setPipeline), []);

  const own = config.dictate;
  const saveRules = (patch: Partial<CleanupRules>) => save({ dictate: { cleanup: { ...own.cleanup, ...patch } } });
  const language = CURATED_LANGUAGES.find((l) => l.code === pipeline.language)?.name ?? pipeline.language;
  // The rules are English; elsewhere only punctuation applies (lib/dictate/cleanup.ts).
  const english = pipeline.language === "en";
  const key = liveKeys(config.talk).dictate;

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-dictate-trigger" title="Trigger" desc="How you start and stop. Set in General.">
        {caps?.addonError
          ? <AddonCard error={caps.addonError} packaged={caps.packaged} user="dictate" onRetry={refresh} />
          : (
            <ListGroup>
              <LinkRow icon={Keyboard} label="Open and close" detail="Double-tap in any app, or the mic by Flow's orb" shared={false} onGo={() => go("general", "set-general-dictate-key")}
                value={<Keycaps keys={hotkeyKeys(key, desktopPlatform)} label={`Double-tap ${keyName(key, desktopPlatform)}`} />} />
              <TalkLinks talk={config.talk} />
            </ListGroup>
          )}
      </Section>

      <BrainSection config={config} save={save} />
      <SharedSettings id="set-dictate-shared" insertion={config.insertion} speaks={false} />

      <Section id="set-dictate-cleanup" title="Cleanup" desc="On this machine, instantly.">
        <div className="flex flex-col gap-3">
          <ListGroup>
            {RULES.map((r) => (
              <ListRow key={r.id} label={r.label} detail={english ? r.detail : r.id === "punctuation" ? "A capital and a full stop" : `English only, not ${language}`} info={r.info} asLabel>
                <Switch on={own.cleanup[r.id]} onFlip={() => saveRules({ [r.id]: !own.cleanup[r.id] })} />
              </ListRow>
            ))}
          </ListGroup>
          <Example rules={own.cleanup} />
        </div>
      </Section>

      <Section id="set-dictate-polish" title="AI polish" desc="Rewrites with your API key or a coding agent. Slower, leaves this machine.">
        <ListGroup>
          <ListRow label="AI polish" detail={own.polish.enabled ? "After cleanup" : "Off"} asLabel
            info={`After the cleanup rules, whoever answers for Dictate rewrites what you said in the tone you pick. If it hasn't answered in ${POLISH_MS / 1000} seconds, or fails, the cleaned-up words are typed instead. A snippet is never rewritten.`}>
            <Switch on={own.polish.enabled} onFlip={() => save({ dictate: { polish: { ...own.polish, enabled: !own.polish.enabled } } })} />
          </ListRow>
          {own.polish.enabled && (
            <ListRow label="Tone">
              <Segmented label="Tone" size="sm" value={own.polish.tone} onChange={(tone) => save({ dictate: { polish: { ...own.polish, tone } } })} options={TONES} />
            </ListRow>
          )}
        </ListGroup>
      </Section>

      <DictateHistory own={own} save={(patch) => save({ dictate: patch })} />
    </div>
  );
}

/** Who answers AI polish and edits by voice. Shown once, in the place every mode puts it: an edit uses the same. */
function BrainSection({ config, save }: { config: FlowConfig; save: Save }) {
  const own = config.dictate;
  const { settings } = useDefaultBrain();
  const go = useSettingsNav();
  const flows = flowBrain(config, settings ?? {});
  const label = "Who answers for AI polish and edits";
  return (
    <Section id="set-dictate-brain" title="Who answers" desc="For AI polish and edit by voice. Plain dictation never uses one.">
      <div className="flex flex-col gap-3">
        <ListGroup>
          <ListRow label={label} detail={own.brain.override ? "Only in Dictate. Flow is unchanged." : undefined}
            info="AI polish and edit by voice send the words, and a selection to edit, as text only, to the one picked here. Plain dictation stays on this machine.">
            <Select aria-label={label} value={own.brain.override ? "own" : "flow"}
              onChange={(e) => save({ dictate: { brain: e.target.value === "own" ? { ...flows, override: true } : { ...own.brain, override: false } } })}>
              <option value="flow">Same as Flow</option>
              <option value="own">Its own</option>
            </Select>
          </ListRow>
          {!own.brain.override && <LinkRow label="Flow's choice" value={<AnswerSummary brain={settings ? flows : null} />} onGo={() => go("flow", "set-flow-brain")} />}
        </ListGroup>
        {own.brain.override && (
          <WhoAnswers id="dictate" label={label} value={dictateBrain(config, {})}
            onPick={(p) => save({ dictate: { brain: { ...own.brain, ...p } } })} />
        )}
      </div>
    </Section>
  );
}

function Commands({ config, save }: { config: FlowConfig; save: Save }) {
  const own = config.dictate;
  const go = useSettingsNav();
  const { editReady } = useFlowConfig();
  const { settings } = useDefaultBrain();
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-dictate-edit" title="Edit by voice" desc="Select text, then talk.">
        <ListGroup>
          <ListRow label={<StatusDot tone={editReady ? "success" : "arc"}>{editReady ? "Ready" : "Needs Dictate's AI"}</StatusDot>}
            detail={editReady ? "Say the change, like “make this formal”" : "Until then, what you say is typed over the selection"}
            info="Select text in any app, open Dictate and say what to change, like “make this formal” or “translate to Spanish”. The orb shows Editing selection, and the selection is rewritten in place. It is read through the system's accessibility API only, never copied, so apps that don't share their selection that way, and Wayland, get your words typed instead." />
          <LinkRow label="Who answers" value={<AnswerSummary brain={settings ? dictateBrain(config, settings) : null} />}
            onGo={() => go("dictate", "set-dictate-brain", "set-dictate-basics")} />
        </ListGroup>
      </Section>

      <Section id="set-dictate-spoken" title="Spoken commands" desc={loadPipelineConfig().language === "en" ? "Said alone, or after a pause." : "Said in English only, alone or after a pause."}>
        <ListGroup>
          {SPOKEN.map((c) => (
            <ListRow key={c.id} label={c.label} detail={c.detail} info={c.info} asLabel>
              <Switch on={own.commands[c.id]} onFlip={() => save({ dictate: { commands: { ...own.commands, [c.id]: !own.commands[c.id] } } })} />
            </ListRow>
          ))}
        </ListGroup>
      </Section>
    </div>
  );
}

/** The cleanup rules as they stand, run on one sentence. */
function Example({ rules }: { rules: CleanupRules }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-label">
      <p className="break-words text-muted-foreground"><span className="font-medium text-muted-strong">You said </span>{EXAMPLE}</p>
      <p className="whitespace-pre-line break-words text-foreground"><span className="font-medium text-muted-strong">Typed </span>{cleanup(EXAMPLE, rules)}</p>
    </div>
  );
}
