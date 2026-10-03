"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu, Languages, TextCursorInput } from "lucide-react";
import type { DictateTone, FlowConfig } from "@openlive/flow-store";
import { Button, Keycaps, ListGroup, ListRow, Segmented, Select, Switch } from "@/components/ui";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { cleanup, type CleanupRules } from "@/lib/dictate/cleanup";
import { POLISH_MS } from "@/lib/dictate/run";
import { bindingOf, hotkeyKeys, mayBeAltGr } from "@/lib/dictate/hotkey";
import { CURATED_LANGUAGES, familyInfo, loadPipelineConfig, onPipelineConfig } from "@/lib/live/pipelineConfig";
import { dictateBrain, flowBrain, toggleKeyOk } from "@openlive/flow-store/shared";
import { AddonCard } from "@/components/flow/AddonCard";
import { Section } from "./Section";
import { LinkRow, useSettingsNav } from "./nav";
import { ModeOnLine, QueryState, StatusDot } from "./common";
import { DictateWords } from "./DictateWords";
import { DictateHistory } from "./DictateHistory";
import { AnswerSummary, useDefaultBrain, WhoAnswers } from "./WhoAnswers";

// The Dictate tab configures; Dictate's home is where it is switched on and
// used, and where its history is. Three subtabs. Basics: its key, how it
// cleans up what was said, AI polish and who answers it and commands, and how
// long history is kept. Words: the dictionary and snippets. Commands: command
// mode and the spoken commands. Typing, voice and the speech engine are shared
// with Flow and Chat, so they are rows that go there.

const DEFAULT_KEY = "option";
type Pane = "basics" | "words" | "commands";
const TONES: { id: DictateTone; label: string }[] = [{ id: "natural", label: "Natural" }, { id: "casual", label: "Casual" }, { id: "formal", label: "Formal" }];
const SPOKEN: { id: keyof FlowConfig["dictate"]["commands"]; label: string; detail: string; info?: string }[] = [
  { id: "enter", label: "“Press enter”", detail: "Presses Return" },
  { id: "newLine", label: "“New line”", detail: "Line break, no send", info: "Shift+Return, which breaks the line in chat boxes without sending. In a terminal it runs the line." },
  { id: "newParagraph", label: "“New paragraph”", detail: "Two line breaks" },
  { id: "undo", label: "“Undo that”", detail: "Removes the last insert",
    info: "Said on its own. One Backspace per character Dictate typed last, so it only works while the cursor is still at the end of it. It never presses Ctrl+Z, which suspends a program in a terminal." },
  { id: "stop", label: "“Stop dictating”", detail: "Ends hands-free" },
];
/** Keys that are never AltGr, for a layout where Right Alt is. */
const ALTERNATIVES = ["option_left", "f13"];
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
  const ins = config.insertion;
  const language = CURATED_LANGUAGES.find((l) => l.code === pipeline.language)?.name ?? pipeline.language;
  // The rules are English; elsewhere only punctuation applies (lib/dictate/cleanup.ts).
  const english = pipeline.language === "en";

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-dictate-trigger" title="Trigger" desc="How you start and stop.">
        {caps?.addonError
          ? <AddonCard error={caps.addonError} packaged={caps.packaged} onRetry={refresh} />
          : (
            <ListGroup>
              <HotkeyRow binding={config.talk.dictateKey} fallback={DEFAULT_KEY} taken={config.talk.flowKey} onPick={(dictateKey) => save({ talk: { dictateKey } })}
                label="Open and close" detail="Tap twice, again to stop"
                info="Tap the key twice in any app, or press the mic beside Flow's orb, or ask Flow to start dictation. Each pause types what you said." />
            </ListGroup>
          )}
      </Section>

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
            info={`After the cleanup rules, the one that answers below rewrites what you said in the tone you pick. If it has not answered in ${POLISH_MS / 1000} seconds, or fails, the cleaned-up words are typed instead. A snippet is never rewritten.`}>
            <Switch on={own.polish.enabled} onFlip={() => save({ dictate: { polish: { ...own.polish, enabled: !own.polish.enabled } } })} />
          </ListRow>
          {own.polish.enabled && (
            <ListRow label="Tone">
              <Segmented label="Tone" size="sm" value={own.polish.tone} onChange={(tone) => save({ dictate: { polish: { ...own.polish, tone } } })} options={TONES} />
            </ListRow>
          )}
        </ListGroup>
      </Section>

      <BrainSection config={config} save={save} />

      <Section id="set-dictate-shared" title="Shared settings" desc="Set once, used everywhere.">
        <ListGroup>
          <LinkRow icon={TextCursorInput} label="Typing at cursor" shared={false} onGo={() => go("general", "set-general-typing")}
            value={`${ins.method === "paste" ? "Paste" : "Type it out"}${ins.method === "paste" && ins.restoreClipboard ? ", clipboard put back" : ""}`} />
          <LinkRow icon={Languages} label="Voice" detail="Language" value={language} onGo={() => go("voice", "set-voice-language")} />
          <LinkRow icon={Cpu} label="Speech engine" detail="Speech to text" value={familyInfo("stt", pipeline.stt.family)?.name ?? pipeline.stt.family} onGo={() => go("engine")} />
        </ListGroup>
      </Section>

      <DictateHistory own={own} save={(patch) => save({ dictate: patch })} />
    </div>
  );
}

/** Who answers AI polish and command mode. Shown once, under AI polish: command mode uses the same. */
function BrainSection({ config, save }: { config: FlowConfig; save: Save }) {
  const own = config.dictate;
  const { settings } = useDefaultBrain();
  const go = useSettingsNav();
  const flows = flowBrain(config, settings ?? {});
  const label = "Who answers for AI polish and commands";
  return (
    <Section id="set-dictate-brain" title="Who answers" desc="For AI polish and command mode. Plain dictation never uses one.">
      <div className="flex flex-col gap-3">
        <ListGroup>
          <ListRow label={label} detail={own.brain.override ? "Only in Dictate. Flow is unchanged." : undefined}
            info="AI polish and command mode send the words, as text only, to the one picked here. Plain dictation stays on this machine.">
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
  return (
    <div className="flex flex-col gap-7">
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

/** The key, and a picker that takes the next keys pressed together. */
function HotkeyRow({ binding, fallback, taken: taken_, label, detail, info, onPick }: {
  binding: string; fallback: string; /** Flow's key, which this one may not be. */ taken: string;
  label: string; detail: string; info: string; onPick: (binding: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [refused, setRefused] = useState<"types" | "taken" | false>(false);
  // A save re-renders this row mid-pick, and the keys held so far must survive it.
  const pick = useRef(onPick);
  pick.current = onPick;
  const taken = useRef(taken_);
  taken.current = taken_;

  useEffect(() => {
    if (!picking) return;
    const held = new Set<string>();
    const seen = new Set<string>();
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") return setPicking(false);
      held.add(e.code);
      seen.add(e.code);
    };
    // Taken once every key of the combination is up again.
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      held.delete(e.code);
      if (held.size || !seen.size) return;
      const keys = bindingOf(seen);
      const next = keys && toggleKeyOk(keys, desktopPlatform) ? keys : null;
      seen.clear();
      setRefused(!next ? "types" : next === taken.current ? "taken" : false);
      if (!next || next === taken.current) return;
      setPicking(false);
      pick.current(next);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, [picking]);

  const keys = hotkeyKeys(binding, desktopPlatform);
  return (
    <>
      <ListRow label={label} detail={picking ? "Press a key or combo, Esc cancels" : detail} info={info}>
        {/* One unit, so a narrow row moves the key and its buttons down together. */}
        <span className="flex flex-wrap items-center gap-2">
          {picking
            ? <Button size="sm" onClick={() => setPicking(false)}>Cancel</Button>
            : <Keycaps keys={keys} label={keys.join(" ")} />}
          {!picking && isDesktop && <Button size="sm" onClick={() => { setRefused(false); setPicking(true); }}>Change</Button>}
          {!picking && binding !== fallback && fallback !== taken_ && <Button size="sm" variant="ghost" onClick={() => onPick(fallback)}>Reset</Button>}
        </span>
        {refused && (
          <div className="basis-full">
            <StatusDot tone="arc">{refused === "taken" ? "Flow opens with that key. Pick another." : "That key also types, or is more than one. Use one modifier or F13 to F24."}</StatusDot>
          </div>
        )}
      </ListRow>
      {mayBeAltGr(binding, desktopPlatform) && (
        <ListRow label={<StatusDot tone="arc">Right Alt may be AltGr here</StatusDot>}
          info="On some Windows and Linux layouts Right Alt is AltGr and types characters. If yours is one, pick a key that never types.">
          {ALTERNATIVES.filter((k) => k !== taken_).map((k) => (
            <Button key={k} size="sm" onClick={() => onPick(k)}>{hotkeyKeys(k, desktopPlatform).join(" ")}</Button>
          ))}
        </ListRow>
      )}
    </>
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
