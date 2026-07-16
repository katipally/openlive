"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, ChevronRight, Loader2, PanelRightClose } from "lucide-react";
import { useChat, type ChatMsg, type Part } from "@/lib/chatStore";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { useLiveStore } from "@/lib/live/liveStore";
import { toolMeta as meta } from "@/lib/live/toolMeta";
import { cn } from "@/lib/cn";

// The running conversation, beside the orb. Assistant turns render as they
// happened — a collapsible "work" block (reasoning + tools, interleaved) followed
// by the spoken answer, filled word-by-word in lockstep with the VOICE (see
// useLiveSession) so it always shows exactly what was said. Resizable + closable.
export function TranscriptPanel({ chatId, width, onResize, onClose }: {
  chatId: string; width: number; onResize: (w: number) => void; onClose: () => void;
}) {
  const msgs = useChat(chatId);
  const { userCaption, userPartial } = useLiveStore();
  const scroller = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  // Slide in from the right edge when opened (enter-only; close unmounts, which
  // reads fine for a side panel — same rule as menus/usePopIn).
  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(asideRef.current, { x: 24, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: DUR.base, ease: EASE.out });
  }, { scope: asideRef });

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, userCaption]);

  // Drag the left edge to resize; clamped to a sane range.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onResize(Math.min(640, Math.max(280, window.innerWidth - ev.clientX)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.userSelect = ""; };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const empty = msgs.length === 0 && !(userPartial && userCaption);

  return (
    <aside ref={asideRef} style={{ width }} className="relative flex h-full shrink-0 flex-col bg-surface/40 text-left shadow-[inset_1px_0_0_rgba(0,0,0,0.03)]">
      <div onPointerDown={startResize} title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2 text-[13px] font-semibold">
        Activity
        <button onClick={onClose} title="Hide activity" aria-label="Hide activity"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <div ref={scroller} className="openlive-scroll flex-1 space-y-5 overflow-y-auto p-4">
        {empty && <p className="mt-8 text-center text-[12.5px] text-faint">Your conversation will appear here.</p>}
        {msgs.map((m, i) => (
          <Message key={m.id} msg={m} streaming={m.role === "assistant" && !m.done && i === msgs.length - 1} />
        ))}
        {userPartial && userCaption && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-accent/40 px-3 py-1.5 text-[13px] italic leading-relaxed text-foreground">{userCaption}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Message({ msg, streaming }: { msg: ChatMsg; streaming: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-1.5 text-[13px] leading-relaxed text-accent-foreground">{msg.text}</div>
      </div>
    );
  }

  // Group consecutive reasoning/tool parts into one "work" block; text renders plain.
  type Seg = { kind: "work"; parts: Part[] } | { kind: "text"; text: string };
  const segs: Seg[] = [];
  for (const p of msg.parts) {
    if (p.kind === "reasoning" || p.kind === "tool") {
      const last = segs[segs.length - 1];
      if (last?.kind === "work") last.parts.push(p);
      else segs.push({ kind: "work", parts: [p] });
    } else {
      segs.push({ kind: "text", text: p.text });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {streaming && segs.length === 0 && <span className="arc-shimmer text-[13px] font-medium">Thinking…</span>}
      {segs.map((seg, i) =>
        seg.kind === "work"
          ? <WorkBlock key={i} parts={seg.parts} active={streaming && i === segs.length - 1} />
          : <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{seg.text}</p>,
      )}
    </div>
  );
}

// A run of reasoning + tool calls — the message's "work". Expanded while active,
// auto-collapses to a one-line summary once the answer starts.
function WorkBlock({ parts, active }: { parts: Part[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => { if (wasActive.current && !active) setOpen(false); wasActive.current = active; }, [active]);
  const expanded = open || active;

  const tools = parts.filter((p): p is Extract<Part, { kind: "tool" }> => p.kind === "tool");
  const running = tools.find((t) => !t.done);
  const hasReasoning = parts.some((p) => p.kind === "reasoning");

  return (
    <div className="rounded-lg bg-card/40 shadow-[var(--shadow-xs)]">
      <button onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition hover:text-foreground">
        {active ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> : <Brain className="size-3.5 shrink-0 text-faint" />}
        {active ? (
          <span className="arc-shimmer font-medium">{running ? `${meta(running.tool).active}…` : "Thinking…"}</span>
        ) : (
          <>
            <span className="font-medium text-foreground/80">Worked it out</span>
            {tools.length > 0 && <span className="text-faint">· {tools.length} step{tools.length === 1 ? "" : "s"}</span>}
            {hasReasoning && <span className="text-faint">· reasoned</span>}
          </>
        )}
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 transition", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {parts.map((p, i) =>
            p.kind === "reasoning"
              ? <p key={i} className="whitespace-pre-wrap border-l-2 border-border pl-2.5 text-[12px] italic leading-relaxed text-muted-foreground">{p.text}</p>
              : p.kind === "tool" ? <ToolRow key={i} part={p} /> : null,
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const m = meta(part.tool);
  const Icon = m.icon;
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      {part.done ? <Icon className="size-3.5 shrink-0 text-faint" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />}
      <span className="shrink-0">{part.done ? m.label : `${m.active}…`}</span>
      {part.summary && <span className="truncate text-faint">· {part.summary}</span>}
    </div>
  );
}
