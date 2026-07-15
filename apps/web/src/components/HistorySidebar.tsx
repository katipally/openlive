"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, ChevronRight, Folder, MessageSquare, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { setConversationBind, setConversationFolder, setConversationResume } from "@/lib/live/useLiveSession";
import { AgentIcon } from "./live/AgentIcon";
import { OpenLiveOrb } from "./OpenLiveOrb";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import type { AgentId } from "@/lib/live/liveClient";
import type { HistorySession } from "@openlive/shared";

const isDesktop = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
const basename = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p || "—";
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Left History sidebar: agent → workspace → session, collapsible. Opened by the
// hero "Resume" and toggled during a call. Uses native <details> for the tree
// (no state), GSAP for the slide in/out.
export function HistorySidebar() {
  const open = useUi((s) => s.historyOpen);
  const setOpen = useUi((s) => s.setHistoryOpen);
  const resumeChat = useUi((s) => s.resumeChat);
  const setLiveOpen = useUi((s) => s.setLiveOpen);
  const activeChatId = useUi((s) => s.activeChatId);
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const { data: agents = [], isLoading } = useQuery({ queryKey: ["history"], queryFn: api.history, enabled: open });

  useEffect(() => { if (open) setVisible(true); }, [open]);

  const { contextSafe } = useGSAP(() => {
    if (!visible || prefersReduced()) return;
    gsap.fromTo(root.current, { xPercent: -100, autoAlpha: 0.6 }, { xPercent: 0, autoAlpha: 1, duration: DUR.slow, ease: EASE.out });
    gsap.fromTo(".ol-hist-backdrop", { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft });
  }, { scope: root, dependencies: [visible] });

  const close = contextSafe(() => {
    const done = () => { setVisible(false); setOpen(false); };
    if (!root.current || prefersReduced()) { done(); return; }
    gsap.to(".ol-hist-backdrop", { autoAlpha: 0, duration: DUR.fast, ease: EASE.soft });
    gsap.to(root.current, { xPercent: -100, autoAlpha: 0.6, duration: DUR.base, ease: EASE.out, onComplete: done });
  });

  const resume = (s: HistorySession, agentId: string | null, cwd: string) => {
    // OpenLive session → reopen it. External agent session → a fresh OpenLive
    // conversation that loadSession-s the agent's own prior thread. Either way, set
    // agent + workspace so the lobby shows the right setup and pre-connects.
    let chatId = s.id;
    if (s.source === "external") {
      useUi.getState().newConversation();
      chatId = useUi.getState().activeChatId;
      setConversationResume(chatId, s.resumeSessionId ?? s.id);
    } else {
      resumeChat(chatId);
    }
    setConversationBind(chatId, (agentId ?? null) as AgentId | null);
    if (cwd) setConversationFolder(chatId, cwd);
    setLiveOpen(true);
    close();
  };

  if (!visible) return null;
  return (
    <>
      <div className="ol-hist-backdrop fixed inset-0 z-[54] bg-black/30" onClick={close} />
      <aside ref={root} className="fixed left-0 top-0 z-[55] flex h-full w-[300px] flex-col border-r border-border bg-background text-left shadow-2xl">
        <header className={cn("flex h-14 shrink-0 items-center justify-between border-b border-border pr-3", isDesktop ? "pl-[84px] [-webkit-app-region:drag]" : "pl-4")}>
          <span className="text-[14px] font-semibold">History</span>
          <button onClick={close} aria-label="Close history" className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", isDesktop && "[-webkit-app-region:no-drag]")}><X className="size-4" /></button>
        </header>

        <div className="openlive-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {isLoading && <p className="px-2 py-4 text-[12.5px] text-faint">Loading…</p>}
          {!isLoading && agents.length === 0 && (
            <div className="px-2 py-6 text-center">
              <p className="text-[12.5px] text-muted-foreground">No conversations yet.</p>
              <p className="mt-1 text-[11.5px] text-faint">Start one and it&apos;ll be filed here by agent and workspace.</p>
            </div>
          )}

          {agents.map((agent) => (
            <details key={agent.agentId ?? "openlive"} open className="group/agent">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-foreground transition hover:bg-foreground/[0.05] [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 text-faint transition group-open/agent:rotate-90" />
                {agent.agentId ? <AgentIcon id={agent.agentId as AgentId} className="size-4" /> : <OpenLiveOrb size={16} />}
                <span className="flex-1 truncate">{agent.label}</span>
              </summary>

              <div className="mb-1 ml-3 border-l border-border pl-1.5">
                {agent.workspaces.map((ws) => (
                  <details key={ws.cwd || "none"} open className="group/ws">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.04] [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3 shrink-0 text-faint transition group-open/ws:rotate-90" />
                      <Folder className="size-3.5 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate" title={ws.cwd || "No folder"}>{ws.cwd ? basename(ws.cwd) : "No folder"}</span>
                    </summary>
                    <div className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1.5">
                      {ws.sessions.map((s) => (
                        <button key={s.id} onClick={() => resume(s, agent.agentId, ws.cwd)}
                          className={cn("flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-foreground/[0.05]", s.id === activeChatId && "bg-foreground/[0.07]")}>
                          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-faint" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] text-foreground">{s.title}</span>
                            <span className="block text-[10.5px] text-faint">{relTime(s.updatedAt)}{s.source === "external" && " · external"}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>

        <button onClick={() => { setOpen(false); useUi.getState().newConversation(); useUi.getState().setLiveOpen(true); }}
          className="m-2 flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium text-foreground transition hover:border-border-heavy">
          <Plus className="size-4 text-accent" /> New conversation
        </button>
      </aside>
    </>
  );
}
