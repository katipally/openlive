"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, SlidersHorizontal } from "lucide-react";
import { Button, Keycap, Keycaps, ListGroup } from "@/components/ui";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { tourSeen } from "@/components/SpotlightTour";
import { AgentSelect } from "@/components/live/AgentControls";
import { MODES } from "@/components/flow/ModeSwitch";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { AccessRows } from "@/components/flow/FlowSettings";
import { LinkRow } from "@/components/settings/nav";
import { tile } from "@/components/settings/common";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { afterWelcome, allGranted, FLOW_ONBOARDED_KEY } from "@/lib/flow/onboarding";
import { hotkeyKeys } from "@/lib/dictate/hotkey";
import { CONTROL, desktopPlatform, isDesktop, isMacDesktop, isNonMacDesktop } from "@/lib/platform";
import { useUi, type AppMode } from "@/lib/uiStore";
import { cn } from "@/lib/cn";

// The first run of the whole app, once, for someone new: what the three modes
// are, where the thinking comes from, what the machine has to allow, and one
// thing to try in each mode. Skippable at every step. Flow keeps its own
// onboarding for what only it needs.

const WELCOMED_KEY = "openlive-welcomed";
const STEPS = 4;
const LINE: Record<AppMode, string> = {
  chat: "A voice call with your AI, in this window.",
  flow: "Talk to any app. It types, acts and answers out loud.",
  dictate: "Type with your voice, in any text box.",
};

/** Owed to someone who has never been welcomed and never seen the home tour, which every earlier version showed. */
const owed = (): boolean => { try { return localStorage.getItem(WELCOMED_KEY) !== "1" && !tourSeen("home"); } catch { return false; } };
const markSeen = (): void => { try { localStorage.setItem(WELCOMED_KEY, "1"); } catch { /* private mode: shown again next launch */ } };
/** Flow's first run opens past its access step when this one covered it. */
const coverFlowAccess = (passed: boolean, granted: boolean): void => {
  try {
    const flag = localStorage.getItem(FLOW_ONBOARDED_KEY);
    const next = afterWelcome(flag, passed, granted);
    if (next !== null && next !== flag) localStorage.setItem(FLOW_ONBOARDED_KEY, next);
  } catch { /* private mode: Flow asks again */ }
};

/** `onPending` tells the page while it is up, so the home tour waits its turn. */
export function Welcome({ onPending }: { onPending: (pending: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const { config, save } = useFlowConfig();
  // Read on open and polled on the access step, so a grant given there counts.
  const { caps } = useFlowCapabilities(open && step === 3);
  const passedAccess = useRef(false);
  const setMode = useUi((s) => s.setMode);
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  // Step 2 opens Settings, which steps in front until it is closed again.
  const settingsOpen = useUi((s) => s.settingsOpen);
  const root = useRef<HTMLDivElement>(null);

  // Decided after mount: localStorage is not there during SSR.
  useEffect(() => setOpen(owed()), []);
  useEffect(() => onPending(open), [open, onPending]);

  const finish = (mode?: AppMode) => {
    markSeen();
    coverFlowAccess(passedAccess.current, allGranted(caps, !!config?.consent.granted));
    setOpen(false);
    if (mode) setMode(mode);
  };
  const next = () => {
    if (step === 3) passedAccess.current = true;
    if (step < STEPS) setStep(step + 1); else finish();
  };
  useFocusTrap(root, open && !settingsOpen, () => finish());

  if (!open || settingsOpen) return null;
  const hold = config ? hotkeyKeys(config.dictate.hotkey, desktopPlatform) : [];

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Welcome to OpenLive" data-covering="settings" className="fixed inset-0 z-settings flex flex-col bg-background text-left">
      <header className={cn("flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isNonMacDesktop ? "pr-window-controls" : "pr-3", isDesktop && "app-drag")}>
        <span className="min-w-0 flex-1 truncate text-body font-semibold">{`Welcome · ${step} of ${STEPS}`}</span>
        <Button variant="ghost" size="sm" onClick={() => finish()} className="[-webkit-app-region:no-drag]">Skip</Button>
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
                    <span className="text-body font-medium text-foreground">{m.label}</span>
                    <span className="break-words text-label text-muted-foreground">{LINE[m.id]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title-lg font-semibold tracking-tight">Pick how OpenLive thinks</h1>
              <p className="text-body text-muted-strong">Your own API key, or a coding agent you already use, under your own login. Every mode can use either.</p>
            </div>
            <ListGroup>
              <LinkRow icon={SlidersHorizontal} label="Your own API key" detail="Any provider, your own model" value="Models" onGo={() => openSettingsTab("models")} />
              <LinkRow icon={Bot} label="A coding agent" detail="Claude Code, Codex, Cursor and more" value="Agents" onGo={() => openSettingsTab("agents")} />
            </ListGroup>
            <div className="flex flex-wrap items-center gap-2 text-label text-muted-strong">Chat talks to <AgentSelect /></div>
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
              <h1 className="text-title-lg font-semibold tracking-tight">Try it</h1>
              <p className="text-body text-muted-strong">One thing to say in each mode. Pick one to start there.</p>
            </div>
            <ListGroup>
              <Try label="Chat" onGo={() => finish("chat")}>Press New, then say &ldquo;What can you do?&rdquo;</Try>
              <Try label="Flow" onGo={() => finish("flow")}>
                Tap <Keycap>{CONTROL}</Keycap> <Keycap>{CONTROL}</Keycap> in any app and say &ldquo;Summarize this page&rdquo;
              </Try>
              <Try label="Dictate" onGo={() => finish("dictate")}>
                In any text box, hold <Keycaps keys={hold} label={hold.join(" ")} className="align-middle" /> and say &ldquo;Running five minutes late&rdquo;
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
