"use client";

import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { TalkMode } from "@openlive/flow-store";
import { defaultPttKey } from "@openlive/flow-store/shared";
import { Button, Keycaps, ListGroup, ListRow, Notice, Segmented, Select, type SegOption } from "@/components/ui";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { flowBridge, valueOr } from "@/lib/flow/bridge";
import { keyListenerNote } from "@/lib/flow/failure";
import { bindingOf, hotkeyKeys, keyIssue, keyName, KEY_OWNER, mayBeAltGr, narrowNote, pickKey, silenceLabel, type Talk, type TalkKey } from "@/lib/dictate/hotkey";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { QueryState, StatusDot } from "./common";

// How you talk, once for Flow, Dictate and calls: hands-free or push to talk,
// when Flow and Dictate close on their own, and the three keys. Every change is
// written to Flow's config, which main re-registers the keys from at once.

const SILENCE = [30_000, 90_000, 300_000];
/** What a press of Fn does on a Mac when it is not Do Nothing (com.apple.HIToolbox AppleFnUsageType). */
const FN_ACTION: Record<number, string> = { 1: "changes the input source", 2: "opens Emoji & Symbols", 3: "starts macOS dictation" };

export function HowYouTalk() {
  const { config, save, error, loading, refetch } = useFlowConfig();
  const { caps } = useFlowCapabilities();
  if (!config) return <QueryState loading={loading} error={error || null} retrying={false} onRetry={refetch} what="read how you talk" />;
  const talk = config.talk;
  const ptt = talk.mode === "ptt";
  const pttName = keyName(talk.pttKey, desktopPlatform);
  const modes: SegOption<TalkMode>[] = [
    { id: "handsFree", label: "Hands-free", title: "Just talk. A pause ends what you said." },
    { id: "ptt", label: "Push to talk", title: isDesktop ? `Hold ${pttName} while you talk. Nothing is heard in between.` : "Hold the Hold to talk button while you talk. Nothing is heard in between." },
  ];
  const silence = talk.closeAfterSilenceMs;
  const known = silence === null || SILENCE.includes(silence);
  const listener = isDesktop ? listenerNote(caps) : "";

  return (
    <div className="flex flex-col gap-3">
      <ListGroup>
        <ListRow label="How you talk"
          detail={ptt ? (isDesktop ? `Hold ${pttName} while you talk` : "Hold the Hold to talk button while you talk") : "Just talk. A pause ends what you said."}
          info="In Flow, Dictate and calls alike. Push to talk hears nothing until you hold the key, so a noisy room or someone beside you is never taken for you.">
          <Segmented label="How you talk" anchor="set-general-talk-mode" value={talk.mode ?? "handsFree"} options={modes} onChange={(mode) => save({ talk: { mode } })} />
        </ListRow>
        {isDesktop && (
          <div id="set-general-silence">
            <ListRow label="Close after silence" detail="Flow and Dictate. A call stays open."
              info={ptt ? "In push to talk, a stretch without a hold counts as silence." : "Nothing said and nothing being answered for this long closes Flow or Dictate."}>
              <Select aria-label="Close after silence" value={silence === null ? "never" : known ? String(silence) : "custom"}
                onChange={(e) => e.target.value !== "custom" && save({ talk: { closeAfterSilenceMs: e.target.value === "never" ? null : Number(e.target.value) } })}>
                {!known && silence !== null && <option value="custom">{silenceLabel(silence)}</option>}
                {SILENCE.map((ms) => <option key={ms} value={ms}>{silenceLabel(ms)}</option>)}
                <option value="never">Never</option>
              </Select>
            </ListRow>
          </div>
        )}
      </ListGroup>

      {isDesktop && (
        <ListGroup>
          <KeyRow role="flowKey" id="set-general-flow-key" label="Open Flow" detail="Double-tap. Again to close." fallback="ctrl" talk={talk} save={save} />
          <KeyRow role="dictateKey" id="set-general-dictate-key" label="Open Dictate" detail={config.dictate.enabled ? "Double-tap. Again to stop." : "Double-tap, once Dictate is on"} fallback="option" talk={talk} save={save} />
          <KeyRow role="pttKey" id="set-general-ptt-key" label="Push to talk" detail={ptt ? "Hold while you talk" : "Held to talk, in Push to talk"} fallback={defaultPttKey(desktopPlatform)} talk={talk} save={save} />
        </ListGroup>
      )}
      {isDesktop && ptt && talk.pttKey === "fn" && desktopPlatform === "darwin" && <FnNotice />}
      {listener && <StatusDot tone={caps?.hookError ? "danger" : "arc"}>{listener}</StatusDot>}
      {error && <p className="text-label text-destructive-text">{error}</p>}
    </div>
  );
}

/** Why the keys cannot work here, and what does work meanwhile. "" while they can. */
function listenerNote(caps: ReturnType<typeof useFlowCapabilities>["caps"]): string {
  const note = keyListenerNote(caps, "shared");
  if (!note) return "";
  const linux = caps?.hookError && desktopPlatform === "linux"
    ? " On Linux the keys need the input group: run sudo usermod -aG input $USER, then sign out and back in." : "";
  return `${note}${linux} In a call, the Hold to talk button works without it.`;
}

/** Fn held to talk also runs whatever macOS does on a press of Fn, which no app
 *  can stop. Read on show and each time the window comes back, as the fix is in
 *  System Settings. Nothing is said while the answer is Do Nothing. */
function FnNotice() {
  const [usage, setUsage] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    const read = () => void flowBridge()?.fnUsage?.().then((r) => setUsage(valueOr(r, null)));
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  if (usage === 0 || usage === undefined) return null;
  const action = (usage !== null && FN_ACTION[usage]) || "runs its own action";
  return (
    <Notice className="flex-wrap items-center">
      <span className="min-w-[12rem] flex-1">
        Each press of Fn also {action}. In Keyboard settings, set &ldquo;Press 🌐 key to&rdquo; to Do Nothing. A keyboard without Fn needs another key above.
      </span>
      <Button size="sm" onClick={() => void flowBridge()?.openSettings("keyboard")}><Settings2 aria-hidden /> Keyboard settings</Button>
    </Notice>
  );
}

type Save = ReturnType<typeof useFlowConfig>["save"];
const SIDES = [{ id: "either", label: "Either side" }, { id: "left", label: "Left" }, { id: "right", label: "Right" }] as const;
type Side = (typeof SIDES)[number]["id"];

/**
 * One key and its picker. Change listens for the next key pressed alone, on the
 * keyboard like everything else here: Esc or Tab gives up. What it heard is
 * kept only when it is a key the hook can watch and clashes with neither other
 * key; otherwise the row says why. Every outcome is announced.
 */
function KeyRow({ role, id, label, detail, fallback, talk, save }: {
  role: TalkKey; id: string; label: string; detail: string; fallback: string; talk: Talk; save: Save;
}) {
  const [picking, setPicking] = useState(false);
  const [issue, setIssue] = useState("");
  const [said, setSaid] = useState("");
  // A save re-renders this row mid-pick; the keys held so far, and the latest
  // settings to check against, must survive it.
  const latest = useRef(talk);
  latest.current = talk;
  const key = talk[role];
  const name = (k: string) => keyName(k, desktopPlatform);

  const apply = (next: string) => {
    const why = keyIssue(role, next, latest.current, desktopPlatform);
    setIssue(why ?? "");
    setSaid(why ?? `${label} is now ${name(next)}.`);
    if (!why && next !== latest.current[role]) save({ talk: { [role]: next } });
  };
  /** Gave up: what was refused on the way goes too, so the key's own notes show again. */
  const cancel = () => { setIssue(""); setSaid("Cancelled."); setPicking(false); };
  const applied = useRef(apply);
  applied.current = apply;

  useEffect(() => {
    if (!picking) return;
    const held = new Set<string>();
    const seen = new Set<string>();
    const codeOf = (e: KeyboardEvent) => e.code || (e.key === "Fn" ? "Fn" : e.key);
    const down = (e: KeyboardEvent) => {
      if (e.key === "Tab") return cancel();
      // Every key is the picker's while it listens, Esc too, ahead of Settings' own Esc.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return cancel();
      held.add(codeOf(e));
      seen.add(codeOf(e));
    };
    // Taken once every key pressed is up again, so a combination is seen whole and refused.
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      held.delete(codeOf(e));
      if (held.size || !seen.size) return;
      const picked = pickKey(role, bindingOf(seen), latest.current, desktopPlatform);
      seen.clear();
      if ("issue" in picked) { setIssue(picked.issue); setSaid(picked.issue); return; }
      setPicking(false);
      applied.current(picked.key);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, [picking, role]);

  const keys = hotkeyKeys(key, desktopPlatform);
  const group = /^(ctrl|option|shift|command)(?:_(left|right))?$/.exec(key);
  const side: Side = (group?.[2] as Side | undefined) ?? "either";
  const sideKey = (s: Side) => (s === "either" ? group![1]! : `${group![1]}_${s}`);
  const note = role === "pttKey" ? "" : narrowNote(role, talk, desktopPlatform);
  const altGr = desktopPlatform !== "darwin" && (role === "pttKey" ? mayBeAltGr(key, desktopPlatform) : group?.[1] === "option");

  return (
    <div id={id}>
      <ListRow label={label} detail={picking ? "Press one key, Esc cancels" : detail}>
        <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {picking
            ? <Button size="sm" autoFocus onClick={cancel}>Cancel</Button>
            : <Keycaps keys={keys} label={name(key)} />}
          {!picking && (
            <Button size="sm" aria-label={`Change ${label} key`} onClick={() => { setIssue(""); setSaid(`Press the key for ${label}. Escape cancels.`); setPicking(true); }}>Change</Button>
          )}
          {!picking && key !== fallback && (
            <Button size="sm" variant="ghost" aria-label={`Reset ${label} key to ${name(fallback)}`} onClick={() => apply(fallback)}>Reset</Button>
          )}
        </span>
        {!picking && role !== "pttKey" && group && (
          <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-label text-muted-foreground">Side</span>
            <Segmented size="sm" label={`${label}: which side`} value={side} onChange={(s) => apply(sideKey(s))}
              options={SIDES.map((s) => ({ ...s, unavailable: s.id === side ? undefined : keyIssue(role, sideKey(s.id), talk, desktopPlatform) ?? undefined }))} />
          </div>
        )}
        {issue && <div className="basis-full"><StatusDot tone="arc">{issue}</StatusDot></div>}
        {!issue && note && <div className="basis-full"><StatusDot tone="muted">{note}</StatusDot></div>}
        {altGr && (
          <div className="basis-full">
            <StatusDot tone={role === "pttKey" || side === "right" ? "arc" : "muted"}>
              {role === "pttKey" || side === "right"
                ? "Right Alt is AltGr on many layouts and types characters there. If yours is one, pick another key."
                : `On a layout with AltGr, Right Alt types characters, so only Left Alt opens ${KEY_OWNER[role]}.`}
            </StatusDot>
          </div>
        )}
        <span aria-live="polite" className="sr-only">{said}</span>
      </ListRow>
    </div>
  );
}
