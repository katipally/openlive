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
import { usePopIn } from "@/lib/usePopIn";
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

/** Compact "Talk to" picker for the pre-call screen — choose the agent BEFORE
 *  starting (styled like the device selects). Same per-conversation bind. */
export function AgentQuickPick() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const options = useVisibleOptions(boundAgent);
  return (
    <label className="flex items-center gap-2 text-muted-foreground">
      <span className="grid size-3.5 shrink-0 place-items-center">{boundAgent ? <AgentIcon id={boundAgent} className="size-3.5" /> : <OpenLiveOrb size={14} />}</span>
      <select value={boundAgent ?? ""} aria-label="Talk to"
        onChange={(e) => { if (activeChatId) setConversationBind(activeChatId, (e.target.value || null) as AgentId | null); }}
        className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground">
        {options.map((o) => <option key={o.id ?? "chat"} value={o.id ?? ""}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Top-bar selector: what THIS conversation talks to — the built-in assistant or a
 *  coding agent (Claude Code / Codex / Cursor). Persisted per conversation. */
export function AgentSelect() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const options = useVisibleOptions(boundAgent);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const noDrag = useNoDrag();
  usePopIn(menuRef, open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.id === boundAgent) ?? options[0]!;

  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
        {boundAgent ? <AgentIcon id={boundAgent} className="size-4" /> : <OpenLiveOrb size={16} />} {current.label} <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div ref={menuRef} className="absolute left-0 z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          {options.map((o) => (
            <button key={o.id ?? "chat"} onClick={() => { if (activeChatId) setConversationBind(activeChatId, o.id); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground transition hover:bg-foreground/[0.06]">
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

/** Overlay shown when a bound agent asks permission (run a command, edit files).
 *  The question is also spoken; answer by tapping a chip OR saying yes/no. */
export function PermissionPrompt({ answerPermission }: { answerPermission: (optionId: string) => void }) {
  const permission = useLiveStore((s) => s.permission);
  if (!permission) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 grid place-items-center px-4">
      <div className="pointer-events-auto flex max-w-md flex-col gap-3 rounded-2xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-start gap-2.5">
          <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-accent" />
          <p className="text-[13px] leading-relaxed text-foreground">{permission.question}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {permission.options.map((o) => (
            <button key={o.id} onClick={() => answerPermission(o.id)}
              className={cn("rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition",
                o.id === "deny" ? "border border-border text-muted-foreground hover:text-foreground hover:border-border-heavy"
                  : "bg-foreground text-background hover:opacity-90")}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-center text-[11px] text-faint">…or just say “yes” or “no”.</p>
      </div>
    </div>
  );
}
