"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { TalkMode } from "@openlive/flow-store";
import { Button, ListGroup, Radio } from "@/components/ui";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { coverConcepts, tourSeen } from "@/components/SpotlightTour";
import { MODES, ModeStart } from "@/components/flow/ModeSwitch";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { AccessRows } from "@/components/flow/FlowSettings";
import { useDefaultBrain, WhoAnswers } from "@/components/settings/WhoAnswers";
import { card, grid2, tile } from "@/components/settings/common";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { afterWelcome, allGranted } from "@/lib/flow/onboarding";
import { useOnboarding } from "@/lib/prefs";
import { keyName } from "@/lib/dictate/hotkey";
import { desktopPlatform, isDesktop, isMac, isMacDesktop, isNonMacDesktop } from "@/lib/platform";
import { useUi, type AppMode } from "@/lib/uiStore";
import { cn } from "@/lib/cn";

// The first run of the whole app, once, for someone new: what the three modes
// are, who answers you, what the machine has to allow, how you talk, and one
// thing to try in each mode. Skippable at every step. Flow keeps its own
// onboarding for what only it needs.

const STEPS = 4;

/** Owed to someone who has never been welcomed and never seen the home tour, which every earlier version showed. */
const owed = (): boolean => !useOnboarding.getState().welcomed && !tourSeen("home");
const markSeen = (): void => { useOnboarding.setState({ welcomed: true }); };
/** Flow's first run opens past its access step when this one covered it. */
const coverFlowAccess = (passed: boolean, granted: boolean): void => {
  const flag = useOnboarding.getState().flowOnboarded;
  const next = afterWelcome(flag, passed, granted);
  if (next !== null && next !== flag) useOnboarding.setState({ flowOnboarded: next });
};

/** `onPending` tells the page while it is up, so the home tour waits its turn. */
export function Welcome({ onPending }: { onPending: (pending: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const { config, save } = useFlowConfig();
  // Read on open and polled on the access step, so a grant given there counts.
  const { caps } = useFlowCapabilities(open && step === 3);
  const passedAccess = useRef(false);
  // The furthest step seen: the tours this launch drop what it showed.
  const reached = useRef(1);
  const setMode = useUi((s) => s.setMode);
  const answers = useDefaultBrain();
  // Step 2 opens Settings, which steps in front until it is closed again.
  const settingsOpen = useUi((s) => s.settingsOpen);
  const root = useRef<HTMLDivElement>(null);
  // Skipped, Welcome never comes back, so both ways out (Skip and Esc) ask first.
  const [asking, setAsking] = useState(false);

  // Decided after mount, so the first frame is the home it covers; and again
  // after Show me around again, in About, once no call is up.
  const welcomed = useOnboarding((s) => s.welcomed);
  const liveOpen = useUi((s) => s.liveOpen);
  useEffect(() => { if (!liveOpen) setOpen(owed()); }, [welcomed, liveOpen]);
  useEffect(() => onPending(open), [open, onPending]);

  const finish = (mode?: AppMode) => {
    markSeen();
    coverConcepts(...(["modes", "whoAnswers"] as const).slice(0, reached.current));
    coverFlowAccess(passedAccess.current, allGranted(caps, !!config?.consent.granted));
    setOpen(false);
    if (mode) setMode(mode);
  };
  const next = () => {
    if (step === 3) passedAccess.current = true;
    if (step < STEPS) { setStep(step + 1); reached.current = Math.max(reached.current, step + 1); } else finish();
  };
  // Focus goes back to the dialog, not to wherever the gone question leaves it.
  const keepGoing = () => { setAsking(false); root.current?.focus(); };
  useFocusTrap(root, open && !settingsOpen, () => (asking ? keepGoing() : setAsking(true)));

  if (!open || settingsOpen) return null;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Welcome to OpenLive" data-covering="settings" className="fixed inset-0 z-settings flex flex-col bg-background text-left">
      <header className={cn("flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isNonMacDesktop ? "pr-window-controls" : "pr-3", isDesktop && "app-drag")}>
        <span className="min-w-0 flex-1 truncate text-body font-semibold">{`Welcome · ${step} of ${STEPS}`}</span>
        {asking ? (
          <span role="group" aria-labelledby="welcome-skip" className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
            <span id="welcome-skip" aria-live="polite" className="whitespace-nowrap text-label text-muted-strong">Skip setup?</span>
            <Button variant="ghost" size="sm" autoFocus onClick={keepGoing}>Keep going</Button>
            <Button variant="secondary" size="sm" onClick={() => finish()}>Skip</Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAsking(true)} className="[-webkit-app-region:no-drag]">Skip</Button>
        )}
      </header>

      <FlowCanvas className="max-w-[40rem]">
        {step === 1 && (
          <>
            <div className="flex flex-col gap-3">
              <OpenLiveMark size={48} />
              <h1 className="text-title-lg font-semibold tracking-tight">Welcome to OpenLive</h1>
              <p className="text-body leading-relaxed text-muted-strong">Ears, eyes, and a voice for your AI. Three ways to use it, switched at the top of the window:</p>
            </div>
            <ul className="flex flex-col gap-3">
              {MODES.map((m) => (
                <li key={m.id} className="flex items-start gap-3">
                  <span className={tile}><m.icon aria-hidden /></span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-foreground">{m.label} <span className="font-normal text-muted-strong">{m.tagline}</span></span>
                    <span className="break-words text-label leading-relaxed text-muted-foreground">{m.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title-lg font-semibold tracking-tight">Who answers you</h1>
              <p className="text-body text-muted-strong">Your own API key, or a coding agent you already use, under your own login. New chats and Flow start with it, and so does Dictate&rsquo;s AI polish; plain dictation needs neither. Change it any time in Settings.</p>
            </div>
            <WhoAnswers id="welcome" label="Who answers you" value={answers.brain} onPick={answers.pick} />
          </>
        )}

        {step === 3 && (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title-lg font-semibold tracking-tight">Let it hear and type</h1>
              <p className="text-body text-muted-strong">Flow and Dictate work in other apps, so the system asks you first. Anything left now is asked for the first time it is needed.</p>
            </div>
            <AccessRows config={config} save={save} askedFrom="onboarding" />
          </>
        )}

        {step === 4 && (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title-lg font-semibold tracking-tight">How you talk</h1>
              <p className="text-body text-muted-strong">The same in Flow, Dictate and calls. Change it any time in Settings{isDesktop ? `, or from the ${isMac ? "menu bar" : "tray"} icon` : ""}.</p>
            </div>
            <TalkChoice value={config?.talk.mode ?? "handsFree"} pttKey={config?.talk.pttKey} onPick={(mode) => save({ talk: { mode } })} />
            <div className="flex flex-col gap-1.5">
              <h2 className="text-title-sm font-semibold">Try it</h2>
              <p className="text-body text-muted-strong">One thing to say in each mode. Pick one to start there.</p>
            </div>
            <ListGroup>
              <Try label="Chat" onGo={() => finish("chat")}><ModeStart mode="chat" /> Say &ldquo;What can you do?&rdquo;</Try>
              <Try label="Flow" onGo={() => finish("flow")}><ModeStart mode="flow" on /> Say &ldquo;Summarize this page&rdquo;</Try>
              <Try label="Dictate" onGo={() => finish("dictate")}>
                <ModeStart mode="dictate" on={config?.dictate.enabled} /> Say &ldquo;Running five minutes late&rdquo;
              </Try>
            </ListGroup>
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {step > 1 && (
            <Button variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
              <ArrowLeft aria-hidden /> Back
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="primary" size="lg" onClick={next}>
            {step < STEPS ? "Continue" : "Done"}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </FlowCanvas>
    </div>
  );
}

/** Hands-free or push to talk, as two cards that are one radio group. */
function TalkChoice({ value, pttKey, onPick }: { value: TalkMode; pttKey?: string; onPick: (mode: TalkMode) => void }) {
  const hold = isDesktop && pttKey ? `Hold ${keyName(pttKey, desktopPlatform)}` : "Hold the Hold to talk button";
  const options: { id: TalkMode; label: string; detail: string }[] = [
    { id: "handsFree", label: "Hands-free", detail: "Just talk. A pause ends what you said." },
    { id: "ptt", label: "Push to talk", detail: `${hold} while you talk. Nothing is heard in between.` },
  ];
  return (
    <div role="radiogroup" aria-label="How you talk" className={grid2}>
      {options.map((o) => (
        <label key={o.id} className={cn(card, "cursor-pointer flex-row items-start gap-3 p-4 ring-1 transition",
          value === o.id ? "ring-accent" : "ring-transparent hover:ring-border")}>
          <Radio name="welcome-talk" value={o.id} checked={value === o.id} onChange={() => onPick(o.id)} className="mt-0.5" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium text-foreground">{o.label}</span>
            <span className="break-words text-label leading-relaxed text-muted-foreground">{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function Try({ label, onGo, children }: { label: string; onGo: () => void; children: React.ReactNode }) {
  return (
    <div className="flex min-h-row flex-wrap items-center gap-x-4 gap-y-2 py-2">
      <span className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <span className="text-body font-medium text-foreground">{label}</span>
        <span className="break-words text-label leading-relaxed text-muted-foreground">{children}</span>
      </span>
      <Button size="sm" onClick={onGo}>Open {label}</Button>
    </div>
  );
}
