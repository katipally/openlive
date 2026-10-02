"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_LIST, agentLabel } from "@openlive/shared";
import { api } from "@/lib/api";
import { useLiveStore } from "@/lib/live/liveStore";
import { setConversationBind } from "@/lib/live/useLiveSession";
import type { AgentId } from "@/lib/live/liveClient";
import { AgentIcon } from "./AgentIcon";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { ModalVoiceInput } from "./ModalVoiceInput";
import { AskLine } from "./AskLine";
import { useUi } from "@/lib/uiStore";
import { usePresence } from "@/lib/usePopIn";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { Picker } from "./SetupControls";
import { cn } from "@/lib/cn";
import { Button, menuItem, menuPanel, MenuCheck, useMenu, pill, sidePanel } from "@/components/ui";

// Hydration-safe: false on the server + first client render (SSR markup matches),
// true only after mount inside the Electron app — so the -webkit-app-region class
// never flips during hydration. AgentSelect renders in the SSR'd landing hero.
function useNoDrag(): string {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent)); }, []);
  return desktop ? "[-webkit-app-region:no-drag]" : "";
}

// The built-in assistant + every registry agent, in canonical order.
const OPTIONS: { id: AgentId | null; label: string }[] = [
  { id: null, label: "API mode" },
  ...AGENT_LIST.map((a) => ({ id: a.id as AgentId, label: a.label })),
];

/** OPTIONS minus agents hidden in Settings — the currently-bound agent stays
 *  visible even when hidden, so an old conversation still shows what it talks to. */
function useVisibleOptions(boundAgent: AgentId | null) {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return OPTIONS.filter((o) => !o.id || o.id === boundAgent || settings?.[`agentHidden:${o.id}`] !== "1");
}

export { agentLabel };

/** "Talk to" picker for the pre-call panel — choose the agent BEFORE starting.
 *  Same per-conversation bind, and the same brand-marked popover as the hero
 *  selector, so the panel and the hero read as one control in two places.
 *  Uninstalled/signed-out agents stay pickable (the Start CTA explains the gap
 *  and links to Settings) but say so up front, rather than looking ready. */
export function AgentQuickPick() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const options = useVisibleOptions(boundAgent);
  const { data: rows } = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const gapOf = (id: AgentId | null): string | undefined => {
    if (!id) return undefined;
    const r = rows?.find((x) => x.id === id);
    if (!r) return undefined;
    if (!r.installed) return "Not installed";
    if (r.credState === "login_required") return r.wizard ? "Setup incomplete" : "Sign in needed";
    return undefined;
  };
  return (
    <Picker
      ariaLabel="Talk to"
      value={boundAgent ?? ""}
      onChange={(id) => { if (activeChatId) setConversationBind(activeChatId, (id || null) as AgentId | null); }}
      options={options.map((o) => ({
        id: o.id ?? "",
        name: o.label,
        detail: o.id ? gapOf(o.id) : "BYOK",
        icon: o.id ? <AgentIcon id={o.id} className="size-4" /> : <OpenLiveOrb size={16} />,
      }))}
    />
  );
}

/** Top-bar selector: what THIS conversation talks to — the built-in assistant or a
 *  coding agent (Claude Code / Codex / Cursor). Persisted per conversation. */
export function AgentSelect() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const options = useVisibleOptions(boundAgent);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const noDrag = useNoDrag();
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);

  const current = options.find((o) => o.id === boundAgent) ?? options[0]!;

  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={`Talk to ${current.label}`}
        className={cn(pill, "max-w-full gap-2 pl-1")}>
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/[0.06]">
          {boundAgent ? <AgentIcon id={boundAgent} className="size-3.5" /> : <OpenLiveOrb size={16} />}
        </span>
        <span className="min-w-0 truncate">{current.label}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>
      {mounted && (
        <div ref={menuRef} role="menu" aria-label="Talk to" className={cn("absolute left-0 z-overlay mt-1.5 w-56 overflow-hidden", menuPanel)}>
          {options.map((o) => (
            <button key={o.id ?? "chat"} role="menuitemradio" aria-checked={o.id === boundAgent} onClick={() => { if (activeChatId) setConversationBind(activeChatId, o.id); requestClose(); }}
              className={cn(menuItem, "text-body text-foreground")}>
              {o.id ? <AgentIcon id={o.id} className="size-4" /> : <OpenLiveOrb size={16} />}
              <span className="flex-1">{o.label}</span>
              {!o.id && <span className="text-caption text-muted-foreground">BYOK</span>}
              {o.id === boundAgent && <MenuCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Seconds until the server's auto-deny, ticking once a second. Null without a
 *  deadline (older server) or once it has passed. */
function useCountdown(expiresAt?: number): number | null {
  const [left, setLeft] = useState(() => (expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : null));
  useEffect(() => {
    if (!expiresAt) { setLeft(null); return; }
    const tick = () => setLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

/** Overlay shown when a bound agent asks permission (run a command, edit files).
 *  The question is also spoken; answer by tapping a chip OR saying yes/no. An
 *  unanswered ask auto-denies server-side — the countdown makes that visible. */
export function PermissionPrompt({ answerPermission }: { answerPermission: (optionId: string) => void }) {
  const live = useLiveStore((s) => s.permission);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = !!live;
  // Retain the last ask through the exit fade (it's null the instant it's answered).
  const last = useRef(live);
  if (live) last.current = live;
  const permission = live ?? last.current;
  const left = useCountdown(permission?.expiresAt);
  const mounted = usePresence(rootRef, open);
  const titleId = useId();
  // Esc is a "no": the conservative answer, never an approval.
  const reject = permission?.options.find((o) => o.id === "deny" || o.kind?.startsWith("reject"));
  useFocusTrap(rootRef, mounted, () => { if (live && reject) answerPermission(reject.id); });
  if (!mounted || !permission) return null;
  const firstAllow = permission.options.findIndex((o) => o.id !== "deny" && !o.kind?.startsWith("reject"));
  const mmss = left != null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : null;
  return (
    // A real centered modal: the agent is blocked on this answer, so it owns the
    // stage. Dim backdrop (no click-through — an approval needs an explicit
    // answer), card centered in the main view. z-modal keeps it above Settings if
    // that's open mid-call (else the ask renders behind it and auto-denies).
    <div ref={rootRef} className="ol-over-settings fixed inset-0 z-modal grid place-items-center scrim px-4">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn(sidePanel(true), "animate-modal-in w-full max-w-md gap-3 p-4")}>
        <AskLine id={titleId} question={permission.question} />
        <ModalVoiceInput hint="Say “yes” to allow, or “no” to reject" />
        <div className="flex flex-wrap justify-end gap-2">
          {permission.options.map((o, i) => (
            <Button key={o.id} size="sm" onClick={() => answerPermission(o.id)}
              variant={o.id === "deny" || o.kind?.startsWith("reject") ? "ghost" : i === firstAllow ? "primary" : "secondary"}>
              {o.label}
            </Button>
          ))}
        </div>
        {mmss && <p className="text-center text-caption text-faint">
          <span className={cn("tabular-nums", (left ?? 0) <= 30 && "text-danger")}>Auto-deny in {mmss}.</span>
        </p>}
      </div>
    </div>
  );
}
