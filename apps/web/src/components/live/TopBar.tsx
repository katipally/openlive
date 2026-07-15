"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Settings2, Minimize2, Plus, MessageSquare, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { AgentSelect } from "./AgentControls";
import { AgentBar } from "./AgentBar";
import { useUi } from "@/lib/uiStore";
import { cn } from "@/lib/cn";

// Running inside the desktop app? Then leave room for the custom window controls
// (top-left) and make the bar draggable (the window is frameless).
const isDesktop = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
const noDrag = isDesktop ? "[-webkit-app-region:no-drag]" : "";

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Conversations() {
  const qc = useQueryClient();
  const activeChatId = useUi((s) => s.activeChatId);
  const resumeChat = useUi((s) => s.resumeChat);
  const newConversation = useUi((s) => s.newConversation);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: chats = [] } = useQuery({ queryKey: ["chats"], queryFn: api.chats, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const del = async (id: string) => {
    await api.deleteChat(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["chats"] });
    if (id === activeChatId) newConversation();
  };

  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
        <MessageSquare className="size-4" /> Conversations <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <button onClick={() => { newConversation(); setOpen(false); }}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-[13px] font-medium text-foreground transition hover:bg-foreground/[0.06]">
            <Plus className="size-4 text-accent" /> New conversation
          </button>
          <div className="openlive-scroll max-h-72 overflow-y-auto py-1">
            {chats.length === 0 && <p className="px-3 py-4 text-center text-[12.5px] text-faint">No saved conversations yet.</p>}
            {chats.map((c) => (
              <div key={c.id} className={cn("group flex items-center gap-2 px-3 py-2 transition hover:bg-foreground/[0.04]", c.id === activeChatId && "bg-foreground/[0.06]")}>
                <button onClick={() => { resumeChat(c.id); setOpen(false); }} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[13px] text-foreground">{c.title || "Conversation"}</div>
                  <div className="text-[11px] text-faint">{relTime(c.createdAt)}</div>
                </button>
                <button onClick={() => del(c.id)} title="Delete" aria-label="Delete conversation"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 transition hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The persistent top bar: logo, conversation history, settings (openable mid-
// call), minimize. Draggable in the desktop app; leaves room for the macOS
// traffic-light buttons.
export function TopBar() {
  const openSettings = useUi((s) => s.openSettings);
  const setMinimized = useUi((s) => s.setMinimized);

  return (
    <header className={cn("flex h-12 shrink-0 items-center justify-between border-b border-border pr-3",
      isDesktop ? "pl-[80px]" : "pl-3",
      isDesktop && "[-webkit-app-region:drag]")}>
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-2 pr-3">
          <OpenLiveOrb size={26} />
          <span className="text-[14px] font-semibold tracking-tight">OpenLive</span>
        </div>
        <Conversations />
        <AgentSelect />
        <AgentBar />
      </div>
      <div className={cn("flex items-center gap-1", noDrag)}>
        <button onClick={openSettings} title="Settings" aria-label="Settings"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
        <button onClick={() => setMinimized(true)} title="Minimize to floating bar" aria-label="Minimize"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Minimize2 className="size-4" /></button>
      </div>
    </header>
  );
}
