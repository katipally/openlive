"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, ShieldQuestion } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_LIST, agentLabel } from "@openlive/shared";
import { api } from "@/lib/api";
import { useLiveStore } from "@/lib/live/liveStore";
import { setConversationBind } from "@/lib/live/useLiveSession";
import type { AgentId } from "@/lib/live/liveClient";
import { AgentIcon } from "./AgentIcon";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { useUi } from "@/lib/uiStore";
import { useMenuPresence, usePresence } from "@/lib/usePopIn";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { Picker } from "./SetupControls";
import { cn } from "@/lib/cn";

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
  { id: null, label: "OpenLive" },
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
        detail: gapOf(o.id),
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
  const { open, mounted, requestClose, toggle } = useMenuPresence(menuRef);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) requestClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = options.find((o) => o.id === boundAgent) ?? options[0]!;

  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button onClick={toggle}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-body text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
        {boundAgent ? <AgentIcon id={boundAgent} className="size-4" /> : <OpenLiveOrb size={16} />} {current.label} <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>
      {mounted && (
        <div ref={menuRef} className="absolute left-0 z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          {options.map((o) => (
            <button key={o.id ?? "chat"} onClick={() => { if (activeChatId) setConversationBind(activeChatId, o.id); requestClose(); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body text-foreground transition hover:bg-foreground/[0.06]">
              {o.id ? <AgentIcon id={o.id} className="size-4" /> : <OpenLiveOrb size={16} />}
              <span className="flex-1">{o.label}</span>
              {o.id === boundAgent && <Check className="size-3.5 text-success" />}
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
  useFocusTrap(rootRef, mounted);
  if (!mounted || !permission) return null;
  const mmss = left != null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : null;
  return (
    // A real centered modal: the agent is blocked on this answer, so it owns the
    // stage. Dim backdrop (no click-through — an approval needs an explicit
    // answer), card centered in the main view. z-modal keeps it above Settings if
    // that's open mid-call (else the ask renders behind it and auto-denies).
    <div ref={rootRef} className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-black/40 px-4 backdrop-blur-[2px]">
      <div className="animate-modal-in flex w-full max-w-md flex-col gap-3 rounded-2xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-start gap-2.5">
          <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-accent" />
          <p className="text-body leading-relaxed text-foreground">{permission.question}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {permission.options.map((o) => (
            <button key={o.id} onClick={() => answerPermission(o.id)}
              className={cn("rounded-lg px-3 py-1.5 text-label font-medium transition",
                o.id === "deny" || o.kind?.startsWith("reject")
                  ? "border border-border text-muted-foreground hover:text-foreground hover:border-border-heavy"
                  : "bg-foreground text-background hover:opacity-90")}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-center text-caption text-faint">
          …or just say “yes” or “no”.
          {mmss && <span className={cn("tabular-nums", (left ?? 0) <= 30 && "text-danger")}> Auto-deny in {mmss}.</span>}
        </p>
      </div>
    </div>
  );
}
