"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { agentLabel, isAgentId } from "@openlive/shared";
import { api, type AgentStatus } from "@/lib/api";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { agentState, API_KEY, CODING_AGENT } from "@/components/settings/WhoAnswers";
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
import { Button, groupLabel, menuItem, menuPanel, MenuCheck, useMenu, pill, sidePanel } from "@/components/ui";

// Hydration-safe: false on the server + first client render (SSR markup matches),
// true only after mount inside the Electron app — so the -webkit-app-region class
// never flips during hydration. AgentSelect renders in the SSR'd landing hero.
function useNoDrag(): string {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent)); }, []);
  return desktop ? "[-webkit-app-region:no-drag]" : "";
}

/** What Chat can talk to, in the two groups every "who answers" place uses:
 *  the API key, then the coding agents set up on this machine, then one line
 *  for those that are not. Agents hidden in Settings stay out, but the bound
 *  one is always listed, so an old conversation still shows what it talks to. */
function useTalkTo(boundAgent: AgentId | null, enabled = true) {
  const { data: rows } = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled });
  const shown = (rows ?? []).filter((r): r is AgentStatus & { id: AgentId } => isAgentId(r.id) && (!r.hidden || r.id === boundAgent));
  // Before the probe answers, the bound agent is all that is known.
  const agents: { id: AgentId; label: string; state?: string }[] = rows
    ? shown.filter((r) => r.installed || r.id === boundAgent).map((r) => ({ id: r.id, label: r.label, state: agentState(r).text }))
    : boundAgent ? [{ id: boundAgent, label: agentLabel(boundAgent) }] : [];
  return { agents, missing: shown.filter((r) => !r.installed && r.id !== boundAgent), loaded: !!rows };
}

const apiDetail = (c: ReturnType<typeof useApiModeChoice>) =>
  c.loading ? "\u2026" : c.usable ? `${c.providerName} \u00b7 ${c.model}` : `${c.providerName}: no key yet`;

export { agentLabel };

/** "Talk to" picker for the pre-call panel — choose the agent BEFORE starting.
 *  Same per-conversation bind as the hero selector, in the same order and words.
 *  A bound agent that is not ready stays listed (the Start CTA explains the gap
 *  and links to Settings) but says so up front, rather than looking ready. */
export function AgentQuickPick() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const { agents } = useTalkTo(boundAgent);
  const choice = useApiModeChoice();
  return (
    <Picker
      ariaLabel="Talk to"
      value={boundAgent ?? ""}
      onChange={(id) => { if (activeChatId) setConversationBind(activeChatId, (id || null) as AgentId | null); }}
      options={[
        { id: "", name: API_KEY, detail: apiDetail(choice), icon: <OpenLiveOrb size={16} /> },
        ...agents.map((a) => ({ id: a.id, name: a.label, detail: a.state, icon: <AgentIcon id={a.id} className="size-4" /> })),
      ]}
    />
  );
}

/** Top-bar selector: what THIS conversation talks to: your API key or a coding
 *  agent (Claude Code / Codex / Cursor). Persisted per conversation. `up`
 *  opens the menu above, for a selector low on the screen. */
export function AgentSelect({ up = false }: { up?: boolean }) {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const noDrag = useNoDrag();
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);
  // The probe runs the person's login shell, so it waits for the menu to open.
  const { agents, missing, loaded } = useTalkTo(boundAgent, mounted);
  const choice = useApiModeChoice();
  const label = boundAgent ? agentLabel(boundAgent) : API_KEY;
  const pick = (id: AgentId | null) => { if (activeChatId) setConversationBind(activeChatId, id); requestClose(); };

  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={`Talk to ${label}`}
        className={cn(pill, "max-w-full gap-2 pl-1")}>
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/[0.06]">
          {boundAgent ? <AgentIcon id={boundAgent} className="size-3.5" /> : <OpenLiveOrb size={16} />}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>
      {mounted && (
        <div ref={menuRef} role="menu" aria-label="Talk to" className={cn("openlive-scroll absolute left-0 z-overlay max-h-[min(24rem,60vh)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto text-left", up ? "bottom-full mb-1.5" : "mt-1.5", menuPanel)}>
          <div role="group" aria-label={API_KEY}>
            <p aria-hidden className={cn("px-2.5 pb-1 pt-1.5", groupLabel)}>{API_KEY}</p>
            <Item checked={!boundAgent} onClick={() => pick(null)} icon={<OpenLiveOrb size={16} />} name={choice.loading ? "\u2026" : choice.providerName}
              detail={choice.loading ? undefined : choice.usable ? `Ready \u00b7 ${choice.model}` : "No key yet"} />
          </div>
          <div role="group" aria-label={CODING_AGENT}>
            <p aria-hidden className={cn("px-2.5 pb-1 pt-3", groupLabel)}>{CODING_AGENT}</p>
            {agents.map((a) => (
              <Item key={a.id} checked={a.id === boundAgent} onClick={() => pick(a.id)} icon={<AgentIcon id={a.id} className="size-4" />}
                name={a.label} detail={a.state} />
            ))}
            {loaded && !agents.length && <p className="px-2.5 py-1.5 text-caption text-muted-foreground">None is set up on this machine yet.</p>}
            {!loaded && <p className="px-2.5 py-1.5 text-caption text-muted-foreground">Looking for coding agents&hellip;</p>}
            {(!!missing.length || (loaded && !agents.length)) && (
              <button type="button" role="menuitem" onClick={() => { requestClose(); openSettingsTab("agents"); }} className={cn(menuItem, "text-caption text-muted-foreground")}>
                <span className="min-w-0 flex-1 break-words">
                  {missing.length ? `Not set up: ${missing.slice(0, 2).map((a) => a.label).join(", ")}${missing.length > 2 ? `, +${missing.length - 2}` : ""}` : "Install one"}
                </span>
                <span className="shrink-0 font-medium text-link-foreground">Set up in Agents &rsaquo;</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ checked, onClick, icon, name, detail }: { checked: boolean; onClick: () => void; icon: React.ReactNode; name: string; detail?: string }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} onClick={onClick} className={cn(menuItem, "text-body text-foreground")}>
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        {detail && <span className="block truncate text-caption text-muted-foreground">{detail}</span>}
      </span>
      {checked && <MenuCheck />}
    </button>
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
