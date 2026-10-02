"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu, Languages, TextCursorInput } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { Button, Keycaps, ListGroup, ListRow, Switch } from "@/components/ui";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { keyListenerNote } from "@/lib/flow/failure";
import { cleanup, type CleanupRules } from "@/lib/dictate/cleanup";
import { bindingOf, hotkeyKeys, mayBeAltGr } from "@/lib/dictate/hotkey";
import { CURATED_LANGUAGES, familyInfo, loadPipelineConfig, onPipelineConfig } from "@/lib/live/pipelineConfig";
import { BrainPicker } from "@/components/flow/BrainPicker";
import { AddonCard } from "@/components/flow/AddonCard";
import { Section } from "./Section";
import { LinkRow, useSettingsNav } from "./nav";
import { QueryState, StatusDot } from "./common";

// The Dictate tab: its key, how it cleans up what was said, and the brain its
// AI polish and commands will use. Typing, voice and the speech engine are
// shared with Flow and Chat, so they are rows that go there.

const DEFAULT_KEY = "option_right";
/** Keys that are never AltGr, for a layout where Right Alt is. */
const ALTERNATIVES = ["ctrl_right", "capslock", "f13"];
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
  const go = useSettingsNav();
  const { caps, refresh } = useFlowCapabilities();
  const [pipeline, setPipeline] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setPipeline), []);

  if (!config) return <QueryState loading={loading} error={error || null} retrying={false} onRetry={refetch} what="read Dictate's settings" />;

  const own = config.dictate;
  const saveRules = (patch: Partial<CleanupRules>) => save({ dictate: { cleanup: { ...own.cleanup, ...patch } } });
  const keyNote = keyListenerNote(caps);
  const ins = config.insertion;
  const language = CURATED_LANGUAGES.find((l) => l.code === pipeline.language)?.name ?? pipeline.language;

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-dictate-trigger" title="Trigger" desc="How you start and stop.">
        {caps?.addonError
          ? <AddonCard error={caps.addonError} packaged={caps.packaged} onRetry={refresh} />
          : (
            <ListGroup>
              <div id="set-dictate-on">
                <ListRow label="Dictate" detail={own.enabled ? "Listening for its key" : "Off until you turn it on"} asLabel>
                  <Switch on={own.enabled} onFlip={() => save({ dictate: { enabled: !own.enabled } })} />
                </ListRow>
              </div>
              <HotkeyRow binding={own.hotkey} onPick={(hotkey) => save({ dictate: { hotkey } })} />
              {keyNote && <ListRow label={<StatusDot tone={caps?.hookError ? "danger" : "arc"}>{keyNote}</StatusDot>} />}
              <ListRow label="Hands-free" detail="Double-tap, then tap to stop"
                info="Or press the mic beside Flow's orb, or ask Flow to start dictation. Each pause types what you said." />
            </ListGroup>
          )}
      </Section>
      {error && <p className="text-label text-destructive-text">{error}</p>}

      <Section id="set-dictate-cleanup" title="Cleanup" desc="On this machine, instantly.">
        <div className="flex flex-col gap-3">
          <ListGroup>
            {RULES.map((r) => (
              <ListRow key={r.id} label={r.label} detail={r.detail} info={r.info} asLabel>
                <Switch on={own.cleanup[r.id]} onFlip={() => saveRules({ [r.id]: !own.cleanup[r.id] })} />
              </ListRow>
            ))}
          </ListGroup>
          <Example rules={own.cleanup} />
        </div>
      </Section>

      <Section id="set-dictate-brain" title="Brain" desc="For AI polish and commands.">
        <div className="flex flex-col gap-3">
          <ListGroup>
            <ListRow label="Use a different one for Dictate" detail={own.brain.override ? "Flow is unchanged" : "Same as Flow"} asLabel
              info="Plain dictation never uses a brain. AI polish and spoken commands will think with this one.">
              <Switch on={own.brain.override} onFlip={() => save({ dictate: { brain: { ...own.brain, override: !own.brain.override } } })} />
            </ListRow>
          </ListGroup>
          {own.brain.override && (
            <BrainPicker config={{ ...config, brain: own.brain }}
              save={(p) => p.brain && save({ dictate: { brain: { ...own.brain, ...p.brain } as FlowConfig["brain"] } })} />
          )}
        </div>
      </Section>

      <Section id="set-dictate-shared" title="Shared settings" desc="Set once, used everywhere.">
        <ListGroup>
          <LinkRow icon={TextCursorInput} label="Typing at cursor" shared={false} onGo={() => go("general", "set-general-typing")}
            value={`${ins.method === "paste" ? "Paste" : "Type it out"}${ins.method === "paste" && ins.restoreClipboard ? ", clipboard put back" : ""}`} />
          <LinkRow icon={Languages} label="Voice" detail="Language" value={language} onGo={() => go("voice", "set-voice-language")} />
          <LinkRow icon={Cpu} label="Speech engine" detail="Speech to text" value={familyInfo("stt", pipeline.stt.family)?.name ?? pipeline.stt.family} onGo={() => go("engine")} />
        </ListGroup>
      </Section>
    </div>
  );
}

/** The key, and a picker that takes the next keys pressed together. */
function HotkeyRow({ binding, onPick }: { binding: string; onPick: (binding: string) => void }) {
  const [picking, setPicking] = useState(false);
  const [refused, setRefused] = useState(false);
  // A save re-renders this row mid-pick, and the keys held so far must survive it.
  const pick = useRef(onPick);
  pick.current = onPick;

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
      const next = bindingOf(seen);
      seen.clear();
      setRefused(!next);
      if (!next) return;
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
      <ListRow label="Hold to talk" detail={picking ? "Press a key or combo, Esc cancels" : "Release types it"}
        info="Hold the key and talk. Letting go types what you said where your cursor is.">
        {picking
          ? <Button size="sm" onClick={() => setPicking(false)}>Cancel</Button>
          : <Keycaps keys={keys} label={keys.join(" ")} />}
        {!picking && isDesktop && <Button size="sm" onClick={() => { setRefused(false); setPicking(true); }}>Change</Button>}
        {!picking && binding !== DEFAULT_KEY && <Button size="sm" variant="ghost" onClick={() => onPick(DEFAULT_KEY)}>Reset</Button>}
        {refused && <div className="basis-full"><StatusDot tone="arc">That key also types. Use a modifier, Caps Lock or F13 to F24.</StatusDot></div>}
      </ListRow>
      {mayBeAltGr(binding, desktopPlatform) && (
        <ListRow label={<StatusDot tone="arc">Right Alt may be AltGr here</StatusDot>}
          info="On some Windows and Linux layouts Right Alt is AltGr and types characters. If yours is one, pick a key that never types.">
          {ALTERNATIVES.map((k) => (
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
